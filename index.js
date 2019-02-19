'use strict';

const MODULE_REQUIRE = 1
    /* built-in */
    , fs = require('fs')
    , path = require('path')
    
    /* NPM */
    , undertake = require('undertake')
    , noda = require('noda')
    , Progress = require('jinang/Progress')
	, trim = require('jinang/trim')
    , sleep = require('jinang/sleep')
    
    /* in-package */
	, FSNode = noda.inRequire('class/FSNode')

    /* in-file */
    ;

const STATUS_NAMES = [ 
	'waiting', 
	'doing', 
	'done', 
	'ignored', 
	'skipped',
	];

/**
 * @param  {string[]}  [options.names]                  names of items (files) to be processed
 * @param  {string}    [options.path]                   home path to be traversed
 * @param  {Function}  [options.processor]              processor module
 * @param  {string}    [options.marker]                 position indicating where previous process finished
 * @param  {number}    [options.maxDone]                maximum processes allowed (the progress will be terminated)
 * @param  {number}    [options.maxDoing]               maximum cocurrent processing operation allowed
 * @param  {number}    [options.maxWaiting]             maximum queue length allowed  
 * @param  {number}    [options.maxErrors]              maximum exceptions allowed (the progress will be terminated)
 * @param  {number}    [options.retry]                  maximum retry times on exception for each item
 * @param  {number}    [options.directoryFirst=false]   traverse order
 * 
 * @return EventEmitter
 */
function traverse(options) {
	let progress = new Progress();

	// ---------------------------
	// Uniform & validate arugments.

	options = Object.assign({
		maxDone      : Number.MAX_SAFE_INTEGER,
		maxDoing     : 100,
        maxWaiting   : 10000,
        maxErrors    : Number.MAX_SAFE_INTEGER,
		retry        : 3,
		directoryFirst : false,
	}, trim.object(options));

	// ---------------------------
	// Progress variables.
	
	// Flags.
    let 
        // Stop finding more items if this value is true.
        stopRegister = false, 

        // Stop processing more items if this value is true.
        stopProcess = false,

		// Indicate if searching finished.
		registerFinished = false;


	// Counters.
    const counter = {
		// Number of those being processed.
        doing: 0,

		// Number of found and registered.
        registered: 0,

		// Number of total errors.
        errors: 0,

		// Number of those already processed.
        done: 0,

		// Number of those ignored.
        ignored: 0,
	};

	// Queues.
    const queue = {
		// List of items waiting for process: FSNode[]
        waiting: [],

		/**
		 * List of unarchived: FSNode[]
		 * status: 
		 *   0 (waiting)
		 *   1 (doing) 
		 *   2 (done) 
		 *   3 (ignored, triggered by exceptions)
		 *   4 (skipped, triggered by predefined conditions, @todo) 
		 */
        unarchived: [],
	};

	// ---------------------------
	// Signals.

	// On signal QUIT received.
    progress.signal(Progress.SIGQUIT, () => {
        stopRegister = true;
	});
	
	// On signal ABORT received.
	progress.signal(Progress.SIGABRT, () => {
        stopRegister = true;
        stopProcess = true;
    });

	// ---------------------------
	// Functions.

	/**
	 * Put found item into waiting list.
	 * @param {FSNode} fsnode 
	 */
	let register = fsnode => {
        if (counter.registered >= options.maxDone) {
            progress.quit();
            return false;
        }
        else {
			fsnode.status = 0;
            queue.unarchived.push(fsnode);
            queue.waiting.push(fsnode);
            counter.registered++;
            next();
            return true;
        }
	};
	
	/**
	 * Take the heading item out of waiting list and process it.
	 */ 
	let next = () => {
        if (stopProcess) {
            return false;
        }

        if (counter.doing >= options.maxDoing) {
            return false;
        }
        else if (queue.waiting.length == 0) {
            return false;
        }
        else {
			// Take the heading item out of waiting list.
			let fsnode = queue.waiting.shift();

			// Process it.
            doing(fsnode);
            return true;
        }
	};

	/**
	 * Process item.
	 * @param {FSNode} fsnode
	 */
	let doing = fsnode => {
		// Update status.
		fsnode.status = 1;

		// Change counter.
		counter.doing++;
		
		let callback = (ex, data) => {
            if (ex) {
				if (fsnode.retries >= options.retry) {
					// Archive item.
					archive(fsnode, 3); // 3 := ignored

					// Trigger error.
					progress.emit('error', ex);
				}
				else {
					fsnode.retry();
					
					// Reset status.
					fsnode.status = 0; // 0 := waiting
	
					// Put at the head of waiting list;
					queue.waiting.unshift(fsnode);
					
					// Trigger warning.
					progress.emit('warning', ex);
				}
	
				// If ceiling reached, cease the whole progress.
				if (++counter.errors >= options.maxErrors) {
					progress.abort();
					return;
				}
			}
			else {
				archive(fsnode, 2); // 2 := done
			}
	
			counter.doing--;
			next();
		};

		// Process item.
		options.processor(fsnode.toObject(), callback);
	};	

	/**
	 * Archive item.
	 * @param {FSNode} fsnode
	 * @param {number} status 
	 */
	let archive = (fsnode, status) => {
		let statusName = STATUS_NAMES[status];

		// Change status.
		fsnode.status = status;
        
		// Change counter.
        counter[statusName]++;

        // Trigger event.
		progress.emit(statusName, { name: fsnode.name });
		
		let i = queue.unarchived.findIndex(q => q === fsnode);
        
        // If it is at the top of the list, archive it.
        if (i == 0) {
            let l = queue.unarchived.length;
            while(i+1 < l && queue.unarchived[i+1].status >= 2) { 
                // >= 2 means created OR ignored OR skipped
                i++;
			}
			
            let markup = queue.unarchived[i].name;
            queue.unarchived.splice(0, i+1);

			// Trigger event.
            progress.emit('moveon', markup);

            try_end();
        }
	};
	
	let try_end = () => {
		if (registerFinished && queue.unarchived.length == 0) {
            progress.emit('end', {
				ignored : counter.ignored,
				done    : counter.done,
				errors  : counter.errors,
			});
        }
	}

	// ---------------------------
	// Deep first searching.
	
	let started = !options.marker;
	let markerPieces, markerDepth;
	if (!started) {
		markerPieces = options.marker.split('/');
		markerDepth = markerPieces.length;
	}
    function* search(dirname, parentRelanamePieces) { 
		let stats = yield undertake.calling(fs.stat, fs, dirname);
		if (!stats.isDirectory()) return;

		// Why not fs.readdirSync() ?
		// To avoid IO blocking.
		let fsnames = yield undertake.calling(fs.readdir, fs, dirname, 'buffer');
		fsnames.sort();

		for (let i = 0; i < fsnames.length; i++) {
			// Stop finding more items if the flag is true.
			if (stopRegister) return;

			// Emit 'no-utf8-name' event if the name is not utf8 encoded.
			let fsname = fsnames[i].toString('utf8');
			if (!Buffer.from(fsname).equals(fsnames[i])) {
				progress.emit('no-utf8-name', {
					dirname: parentNamePieces.join('/'),
					nameBuffer: fsnames[i],
				});
				continue;
			}
			
			let relanamePieces = parentRelanamePieces.concat(fsname);
			let relaname = relanamePieces.join('/');
	
			let registerMe = true, searchChildren = true;
			if (!started) {
				let currentDepth = parentRelanamePieces.length + 1;
				let minDepth = Math.min(markerDepth, currentDepth);
				
				let position = 0;
				for (let i = 0; position == 0 && i < minDepth; i++) {
					let n = relanamePieces[i], m = markerPieces[i];
					if (n < m) position = -1;
					if (n > m) position = 1;
				}

				// The item and its subitems (if exists) already processed before.
				if (position == -1) {
					registerMe = false;
					searchChildren = false;
				}

				// The item and its subitems (if exists) not processed before.
				else if (position == 1) {
					started = true;
				}

				else /* if (position == 0) */ {
					
					// The marker is just the current item.
					if (currentDepth == markerDepth) {
						registerMe = false;
						searchChildren = options.directoryFirst;
					}

					// This case indicates that the marker is a directory,
					// if the tree not changed.
					else if (currentDepth > markerDepth) {
						registerMe = options.directoryFirst;
						searchChildren = options.directoryFirst;
					}

					// This case indicates that current item is a directory,
					// if the tree not changed.
					else /* if (currentDepth < markerDepth) */ {
						registerMe = !options.directoryFirst;
						searchChildren = true;
					}
				}
			}

			let pathname = path.join(dirname, fsname);
			
			if (searchChildren && !options.directoryFirst) {
				yield search(pathname, relanamePieces);
			}
			
			if (registerMe) {
				while (queue.waiting.length >= options.maxWaiting) {
					yield sleep.promise(1000);
				}

				let fsnode = new FSNode({
					relaname,
					pathname,
				});
				register(fsnode);
			}

			if (searchChildren && options.directoryFirst) {
				yield search(pathname, relanamePieces);
			}
		}

		if (parentRelanamePieces.length == 0) {
			registerFinished = true;
			try_end();
		}
	};
	undertake(search(options.path, []));

	// ---------------------------
	// THE END.
    return progress;
}

module.exports = traverse;