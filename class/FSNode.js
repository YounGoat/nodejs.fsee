'use strict';

const MODULE_REQUIRE = 1
	/* built-in */
	
	/* NPM */
	
	/* in-package */
	;

class FSNode {
	constructor(options) {
		this._relaname = options.relaname;
		this._pathname = options.pathname;
		this._retries = 0;
	}

	get name() {
		return this._relaname;
	}

	get path() {
		return this._pathname;
	}

	get status() {
		return this._status;
	}

	set status(value) {
		this._status = value;
	}

	get retries() {
		return this._retries;
	}

	retry() {
		this._retries++;
	}

	toObject() {
		return {
			name: this.name,
			path: this.path,
		};
	}
}

module.exports = FSNode;