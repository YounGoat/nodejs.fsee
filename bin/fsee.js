#!/usr/bin/env node

'use strict';

const MODULE_REQUIRE = 1
    /* built-in */
    , crypto = require('crypto')
    , fs = require('fs')
    , os = require('os')
    , path = require('path')
    
    /* NPM */
    , commandos = require('commandos')
    , noda = require('noda')
    , JsonFile = require('jinang/JsonFile')
    , Directory = require('jinang/Directory')
    , cloneObject = require('jinang/cloneObject')
    , sort = require('jinang/sort')
    , uniq = require('jinang/uniq')
    
    /* in-package */

    /* in-file */
    , NL = '\n'
    ;

// ---------------------------
// Command line options validation.

const OPTIONS = commandos.parse({
    groups: [
        [ '--help -h [0:=*help] REQUIRED' ],
        [ '--version -v REQUIRED' ],
        [ 
            '--path NOT NULL REQUIRED',
            '--processor --js NOT NULL REQUIRED',
            '--concurrency --co NOT NULL',
            '--start-over NOT ASSIGNABLE',
            '--fill NOT ASSIGNABLE',
            '--directory-first NOT ASSIGNABLE',
        ]
    ],
    explicit: true,
    catcher: (err) => {
        console.error(err.message);
        console.log('Run "fsee --help" to see detailed help info.');
        process.exit(1);
    }
});

// Display manual and quit.
if (OPTIONS.help) {
    console.log(noda.inRead('help.txt', 'utf8'));
    process.exit(0);
}

// Display version and quit.
if (OPTIONS.version) {
    console.log('v' + noda.currentPackage.version);
    process.exit(0);
}

OPTIONS.path = path.resolve(OPTIONS.path);
OPTIONS.processor = path.resolve(OPTIONS.processor);
OPTIONS['directory-first'] = !!OPTIONS['directory-first'];

if (!fs.existsSync(OPTIONS.path)) {
    console.error(`Directory ${OPTIONS.path} not exists.`);
    process.exit(1);
}
if (!fs.existsSync(OPTIONS.processor)) {
    console.error(`Processor ${OPTIONS.processor} not exists.`);
    process.exit(1);
}

// ---------------------------
// Main Process.

const options = {
    path: OPTIONS.path,
    directoryFirst: OPTIONS['directory-first'],
};

// 为了实现可续传，我们需要一串包含描述该任务内容的实质性参数（影响该任务的结果，而非过程）。
// 这些参数将构成任务的 taskId 。
const taskIdMeta = {
    path: OPTIONS.path,
    processor: OPTIONS.updater,
    'directory-first': OPTIONS['directory-first'],
};

LOAD_OUTER_MODULES: {
    try {
        options.processor = require(OPTIONS.processor);
    }
    catch (ex) {
        console.error(`Failed to load processor module ${OPTIONS.processor}.`);
        console.error('--------');
        console.error(ex);
        process.exit(1);
    }
}

// Transform the task id object to an MD5 string.
const taskId = crypto.createHash('md5').update(JSON.stringify(taskIdMeta)).digest('hex');

// Get task data from user profile.
let commandHomepath = path.join(os.homedir(), '.fs-traverse');
let taskLogHomepath = path.join(commandHomepath, taskId);
let taskJF = new JsonFile(path.join(taskLogHomepath, 'task.json'));

// Init task info.
// This step is redundant if task already exists.
Object.assign(taskJF.json, taskIdMeta);

// Log filenames.
let taskDir = new Directory(taskLogHomepath);
let logpath = {
    success : 'success.log', 
    error   : 'error.log',
    ignore  : 'ignored.log',
    skipped : 'skipped.log',
    'no-utf8-name' : 'no-utf8-name.log',
};

let runner = noda.inRequire('.');

if (!OPTIONS['start-over'] && !OPTIONS.fill) {
    options.marker = taskJF.json.marker;
}

// Re-traverse those ignored before.
if (OPTIONS.fill) {
    let lines = '';
    [ 'ignored.log', 'ignored.bak' ].forEach(name => {
        if (taskDir.exists(name)) {
            lines += taskDir.read(name, 'utf8');
        }        
    });
    lines = uniq(sort(lines.split(NL))).filter(name => name !== '');
    
    // Backup the ignored list.
    taskDir.write('ignored.bak', lines.join(NL));

    // Delete the previous ignored list.
    taskDir.rmfr('ignored.log');

    options.names = lines;
}

let progress = runner(options);

console.log(`logs in ${taskLogHomepath}`);
console.log('-- START --');

let log = cloneObject(logpath, (name, pathname) => [ name, taskDir.open(pathname, 'a') ] );

progress.on('done', file => {
    console.log('[ DONE    ]', file.name);
    fs.writeSync(log.success, NL + file.name);
});

progress.on('moveon', marker => {
    if (OPTIONS.fill) return;

    console.log('[ MOVEON  ]', marker);
    taskJF.json.marker = marker;
    taskJF.save();
});

progress.on('ignored', file => {
    console.log('[ IGNORED ]', file.name);
    fs.writeSync(log.ignore, NL + file.name);
});

progress.on('skipped', file => {
    console.log('[ SKIPPED ]', file.name);
    fs.writeSync(log.skipped, NL + file.name);
});

progress.on('no-utf8-name', obj => {
    let posname = obj.dirname + ':' + obj.nameBuffer.toString('hex');
    console.log('[ NO-UTF8-NAME ]', posname);
    fs.writeSync(log['no-utf8-name'], NL + posname);
});

progress.on('warning', err => {
    console.log('[ WARNING ]', err.toString());
    fs.writeSync(log.error, NL + err.message);
});

progress.on('error', err => {
    console.log('[ ERROR   ]', err.toString());
    fs.writeSync(log.error, NL + err.message);
});

progress.on('end', meta => {
    console.log('-- END --');
    console.log(`total ${meta.done} done and ${meta.ignored} ignored`);
    console.log(`more logs in ${taskLogHomepath}`);

    // 删除日志备份。
    if (OPTIONS.fill) {
        taskDir.rmfr('ignore.bak');
    }
});
