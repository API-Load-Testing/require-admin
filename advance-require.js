'use strict';

const _ = require('lodash');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const internalModule = require('./internalmodule');
var NodeModule = require('module');
const util         = require("util");
const EventEmitter = require("events").EventEmitter;
const assert = require('assert').ok;
const internalModuleReadFile = process.binding('fs').internalModuleReadFile;
const internalModuleStat = process.binding('fs').internalModuleStat;
const preserveSymlinks = !!process.binding('config').preserveSymlinks;

var NativeModuleRequire = NodeModule.prototype.require;
var NodeDefaultMethods = {};
const _NATIVE_MODULES = ['assert', 'buffer', 'child_process', 'constants', 'crypto', 'tls', 'dgram', 'dns', 'http', 'https', 'net', 'querystring', 'url', 'domain', 'events', 'fs', 'path', 'module', 'os', 'punycode', 'stream', 'string_decoder', 'timers', 'tty', 'util', 'sys', 'vm', 'zlib'];

function MyEventEmitter() {
    EventEmitter.call(this);
}
util.inherits(MyEventEmitter, EventEmitter);
var events = new MyEventEmitter();


function hasOwnProperty(obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
}

var verify = {
    extension: function (str) {
        if (!util.isString(str)) {
            throw new Error('expected string extension, have ' + str);
        }
        if (!str.startsWith('.')) {
            throw new Error('Extension should start with dot, for example .js, have ' + str);
        }
    },
    method: function (fn) {
        if (!util.isFunction(fn)) {
            throw new Error('method should be a function, have ' + fn);
        }
    },
    string: function (str) {
        if (!util.isString(str)) {
            throw new Error('expected string value, have ' + str);
        }
    }
};


var options = function () {

    this.useCopy = false;
    this.reload = false;
    this.allowExternalModules = true;
    this.useSandbox = false;
    this._useNativeModulesCopyList = [];

    this.Blacklist = [];
    this.Whitelist = [];

    this._extentionList = {};  // {Extension: [Method1, ..., MethodN]}
    this._pathList = [];
    this._overrideList = {};  // {ModuleName, Method}
}

options.prototype.addOverrideModule = function (moduleName, method) {

    verify.method(method);
    verify.string(moduleName);
    this._overrideList[moduleName] = method;
};
options.prototype.addOverrideModuleList = function (overrideObject) {

    Object.getOwnPropertyNames(overrideObject).forEach(function(moduleName) {
        var method = overrideObject[moduleName];
        verify.method(method);
        verify.string(moduleName);
        this._overrideList[moduleName] = method;
    });
};

options.prototype.addPath = function (paths) {

    if (!Array.isArray(paths)) paths = [paths];
    var self = this;
    paths.forEach(function (newPath){
        var absolutePath = path.resolve(newPath);
        if (self._pathList.indexOf(absolutePath) < 0)
            self._pathList.push(absolutePath);
    });
};

options.prototype.addExtension = function (ext, method) {

    verify.method(method);
    verify.extension(ext);

    if (!this._extentionList[ext]) this._extentionList[ext] = [];
    if (this._extentionList[ext].indexOf(method) < 0) {
        this._extentionList[ext].push(method);
    }
};
options.prototype.addExtensionList = function (ExtObject) {

    Object.getOwnPropertyNames(ExtObject).forEach(function(keyName) {
        var method = ExtObject[keyName];
        if (util.isFunction(method)) {
            if (!this._extentionList[keyName]) {
                this._extentionList[keyName] = [];
            }
            if (this._extentionList[keyName].indexOf(method) < 0) {
                this._extentionList[keyName].push(method)
            }
        }
    });
};




//*********************************************************************************************

var buildCustomRequire= function(sandbox) {

    function stat(filename) {
        filename = path._makeLong(filename);
        const cache = stat.cache;
        if (cache !== null) {
            const result = cache.get(filename);
            if (result !== undefined) return result;
        }
        const result = internalModuleStat(filename);
        if (cache !== null) cache.set(filename, result);
        return result;
    }
    stat.cache = null;


    function Module(id, parent) {
        this.id = id;
        this.exports = {};
        this.parent = parent;
        if (parent && parent.children) {
            parent.children.push(this);
        }

        this.filename = null;
        this.loaded = false;
        this.children = [];
    }

    Module._cache = {};
    Module._pathCache = {};
    Module._extensions = {};
    var modulePaths = [];
    Module.globalPaths = [];

    Module.wrapper = ['(function (exports, require, module, __filename, __dirname) { ', '\n});'];
    Module.wrap = function (script) {
        return Module.wrapper[0] + script + Module.wrapper[1];
    };

// given a module name, and a list of paths to test, returns the first
// matching file in the following precedence.
//
// require("a.<ext>")
//   -> a.<ext>
//
// require("a")
//   -> a
//   -> a.<ext>
//   -> a/index.<ext>

// check if the directory is a package.json dir
    const packageMainCache = {};

    function readPackage(requestPath) {
        if (hasOwnProperty(packageMainCache, requestPath)) {
            return packageMainCache[requestPath];
        }

        const jsonPath = path.resolve(requestPath, 'package.json');
        const json = internalModuleReadFile(path._makeLong(jsonPath));

        if (json === undefined) {
            return false;
        }

        try {
            var pkg = packageMainCache[requestPath] = JSON.parse(json).main;
        } catch (e) {
            e.path = jsonPath;
            e.message = 'Error parsing ' + jsonPath + ': ' + e.message;
            throw e;
        }
        return pkg;
    }

    function tryPackage(requestPath, exts, isMain) {
        var pkg = readPackage(requestPath);

        if (!pkg) return false;

        var filename = path.resolve(requestPath, pkg);
        return tryFile(filename, isMain) ||
            tryExtensions(filename, exts, isMain) ||
            tryExtensions(path.resolve(filename, 'index'), exts, isMain);
    }

// check if the file exists and is not a directory
// if using --preserve-symlinks and isMain is false,
// keep symlinks intact, otherwise resolve to the
// absolute realpath.
    function tryFile(requestPath, isMain) {
        const rc = stat(requestPath);
        if (preserveSymlinks && !isMain) {
            return rc === 0 && path.resolve(requestPath);
        }
        return rc === 0 && fs.realpathSync(requestPath);
    }

// given a path check a the file exists with any of the set extensions
    function tryExtensions(p, exts, isMain) {
        for (var i = 0; i < exts.length; i++) {
            const filename = tryFile(p + exts[i], isMain);

            if (filename) {
                return filename;
            }
        }
        return false;
    }

    var warned = false;
    Module._findPath = function (request, paths, isMain) {
        if (path.isAbsolute(request)) {
            paths = [''];
        } else if (!paths || paths.length === 0) {
            return false;
        }

        const cacheKey = JSON.stringify({request: request, paths: paths});
        if (Module._pathCache[cacheKey]) {
            return Module._pathCache[cacheKey];
        }

        var exts;
        const trailingSlash = request.length > 0 &&
            request.charCodeAt(request.length - 1) === 47/*/*/;

        // For each path
        for (var i = 0; i < paths.length; i++) {
            // Don't search further if path doesn't exist
            const curPath = paths[i];
            if (curPath && stat(curPath) < 1) continue;
            var basePath = path.resolve(curPath, request);
            var filename;

            if (!trailingSlash) {
                const rc = stat(basePath);
                if (rc === 0) {  // File.
                    if (preserveSymlinks && !isMain) {
                        filename = path.resolve(basePath);
                    } else {
                        filename = fs.realpathSync(basePath);
                    }
                } else if (rc === 1) {  // Directory.
                    if (exts === undefined)
                        exts = Object.keys(Module._extensions);
                    filename = tryPackage(basePath, exts, isMain);
                }

                if (!filename) {
                    // try it with each of the extensions
                    if (exts === undefined)
                        exts = Object.keys(Module._extensions);
                    filename = tryExtensions(basePath, exts, isMain);
                }
            }

            if (!filename) {
                if (exts === undefined)
                    exts = Object.keys(Module._extensions);
                filename = tryPackage(basePath, exts, isMain);
            }

            if (!filename) {
                // try it with each of the extensions at "index"
                if (exts === undefined)
                    exts = Object.keys(Module._extensions);
                filename = tryExtensions(path.resolve(basePath, 'index'), exts, isMain);
            }

            if (filename) {
                Module._pathCache[cacheKey] = filename;
                return filename;
            }
        }
        return false;
    };

// 'node_modules' character codes reversed
    var nmChars = [115, 101, 108, 117, 100, 111, 109, 95, 101, 100, 111, 110];
    var nmLen = nmChars.length;
    if (process.platform === 'win32') {
        // 'from' is the __dirname of the module.
        Module._nodeModulePaths = function (from) {
            // guarantee that 'from' is absolute.
            from = path.resolve(from);

            // note: this approach *only* works when the path is guaranteed
            // to be absolute.  Doing a fully-edge-case-correct path.split
            // that works on both Windows and Posix is non-trivial.
            const paths = [];
            var p = 0;
            var last = from.length;
            for (var i = from.length - 1; i >= 0; --i) {
                const code = from.charCodeAt(i);
                if (code === 92/*\*/ || code === 47/*/*/) {
                    if (p !== nmLen)
                        paths.push(from.slice(0, last) + '\\node_modules');
                    last = i;
                    p = 0;
                } else if (p !== -1 && p < nmLen) {
                    if (nmChars[p] === code) {
                        ++p;
                    } else {
                        p = -1;
                    }
                }
            }

            return paths;
        };
    } else { // posix
        // 'from' is the __dirname of the module.
        Module._nodeModulePaths = function (from) {
            // guarantee that 'from' is absolute.
            from = path.resolve(from);
            // Return early not only to avoid unnecessary work, but to *avoid* returning
            // an array of two items for a root: [ '//node_modules', '/node_modules' ]
            if (from === '/')
                return ['/node_modules'];

            // note: this approach *only* works when the path is guaranteed
            // to be absolute.  Doing a fully-edge-case-correct path.split
            // that works on both Windows and Posix is non-trivial.
            const paths = [];
            var p = 0;
            var last = from.length;
            for (var i = from.length - 1; i >= 0; --i) {
                const code = from.charCodeAt(i);
                if (code === 47/*/*/) {
                    if (p !== nmLen)
                        paths.push(from.slice(0, last) + '/node_modules');
                    last = i;
                    p = 0;
                } else if (p !== -1 && p < nmLen) {
                    if (nmChars[p] === code) {
                        ++p;
                    } else {
                        p = -1;
                    }
                }
            }

            return paths;
        };
    }


// 'index.' character codes
    var indexChars = [105, 110, 100, 101, 120, 46];
    var indexLen = indexChars.length;
    Module._resolveLookupPaths = function (request, parent) {
        if (_NATIVE_MODULES.indexOf(request) >= 0) {
            return [request, []];
        }

        var reqLen = request.length;
        // Check for relative path
        if (reqLen < 2 ||
            request.charCodeAt(0) !== 46/*.*/ ||
            (request.charCodeAt(1) !== 46/*.*/ &&
            request.charCodeAt(1) !== 47/*/*/)) {
            var paths = modulePaths;
            if (parent) {
                if (!parent.paths)
                    paths = parent.paths = [];
                else
                    paths = parent.paths.concat(paths);
            }

            // Maintain backwards compat with certain broken uses of require('.')
            // by putting the module's directory in front of the lookup paths.
            if (request === '.') {
                if (parent && parent.filename) {
                    paths.unshift(path.dirname(parent.filename));
                } else {
                    paths.unshift(path.resolve(request));
                }
            }

            return [request, paths];
        }

        // with --eval, parent.id is not set and parent.filename is null
        if (!parent || !parent.id || !parent.filename) {
            // make require('./path/to/foo') work - normally the path is taken
            // from realpath(__filename) but with eval there is no filename
            var mainPaths = ['.'].concat(Module._nodeModulePaths('.'), modulePaths);
            return [request, mainPaths];
        }

        // Is the parent an index module?
        // We can assume the parent has a valid extension,
        // as it already has been accepted as a module.
        const base = path.basename(parent.filename);
        var parentIdPath;
        if (base.length > indexLen) {
            var i = 0;
            for (; i < indexLen; ++i) {
                if (indexChars[i] !== base.charCodeAt(i))
                    break;
            }
            if (i === indexLen) {
                // We matched 'index.', let's validate the rest
                for (; i < base.length; ++i) {
                    const code = base.charCodeAt(i);
                    if (code !== 95/*_*/ &&
                        (code < 48/*0*/ || code > 57/*9*/) &&
                        (code < 65/*A*/ || code > 90/*Z*/) &&
                        (code < 97/*a*/ || code > 122/*z*/))
                        break;
                }
                if (i === base.length) {
                    // Is an index module
                    parentIdPath = parent.id;
                } else {
                    // Not an index module
                    parentIdPath = path.dirname(parent.id);
                }
            } else {
                // Not an index module
                parentIdPath = path.dirname(parent.id);
            }
        } else {
            // Not an index module
            parentIdPath = path.dirname(parent.id);
        }
        var id = path.resolve(parentIdPath, request);

        // make sure require('./path') and require('path') get distinct ids, even
        // when called from the toplevel js file
        if (parentIdPath === '.' && id.indexOf('/') === -1) {
            id = './' + id;
        }

        return [id, [path.dirname(parent.filename)]];
    };


// Check the cache for the requested file.
// 1. If a module already exists in the cache: return its exports object.
// 2. If the module is native: call `NativeModule.require()` with the
//    filename and return the result.
// 3. Otherwise, create a new module for the file and save it to the cache.
//    Then have it load  the file contents before returning its exports
//    object.
    Module._load = function (request, parent, isMain) {

        var filename = Module._resolveFilename(request, parent, isMain);

        events.emit('require', request, filename);

        if (!userOptions.reload) {
            var cachedModule = Module._cache[filename];
            if (cachedModule) {
                if (_NATIVE_MODULES.indexOf(filename) >= 0) return cachedModule;
                else return cachedModule.exports;
            }
        }

//************************** override list

        if (_NATIVE_MODULES.indexOf(filename) >= 0) {
            var res = NativeModuleRequire(filename);
            if (_.isArray(userOptions._useNativeModulesCopyList)) {
                if (userOptions._useNativeModulesCopyList.indexOf(filename) >= 0)
                    res = _.cloneDeep(res);
            }
            Module._cache[filename] = res;
            return res;
        }

        var module = new Module(filename, parent);

        if (isMain) {
            process.mainModule = module;
            module.id = '.';
        }

        Module._cache[filename] = module;

        tryModuleLoad(module, filename);

        return module.exports;
    };

    function tryModuleLoad(module, filename) {
        var threw = true;
        try {
            module.load(filename);
            threw = false;
        } finally {
            if (threw) {
                delete Module._cache[filename];
            }
        }
    }

    Module._resolveFilename = function (request, parent, isMain) {
        if (_NATIVE_MODULES.indexOf(request) >= 0) {
            return request;
        }

        var resolvedModule = Module._resolveLookupPaths(request, parent);
        var id = resolvedModule[0];
        var paths = resolvedModule[1];

        var filename = Module._findPath(request, paths, isMain);
        if (!filename) {
            var err = new Error("Cannot find module '" + request + "'");
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }
        return filename;
    };


// Given a file name, pass it to the proper extension handler.
    Module.prototype.load = function (filename) {

        assert(!this.loaded);
        this.filename = filename;
        this.paths = Module._nodeModulePaths(path.dirname(filename));

        var extension = path.extname(filename) || '.js';
        if (!Module._extensions[extension]) extension = '.js';
        Module._extensions[extension](this, filename);
        this.loaded = true;
    };


// Loads a module at the given file path. Returns that module's
// `exports` property.
    Module.prototype.require = function (path) {

        assert(path, 'missing path');
        assert(typeof path === 'string', 'path must be a string');

        // This is the require we need to change !!!!!!
        events.emit('beforeRequire', path);

        if (userOptions.Blacklist.indexOf(path) >= 0) {
            throw new Error('Use of module (' + path + ') is restricted.');
        }
        if (userOptions.Whitelist.length > 0 && userOptions.Whitelist.indexOf(path) < 0) {
            throw new Error('Module (' + path + ') is not available.');
        }
        if (!userOptions.allowExternalModules && _NATIVE_MODULES.indexOf(path) < 0) {
            throw new Error('Use of external modules is restricted, have (' + path + ')');
        }

        var resultModule = Module._load(path, this, /* isMain */ false);

        events.emit('afterRequire', resultModule);

        return resultModule;
    };


// Resolved path to process.argv[1] will be lazily placed here
// (needed for setting breakpoint when called with --debug-brk)
    var resolvedArgv;


// Run the file contents in the correct scope or sandbox. Expose
// the correct helper variables (require, module, exports) to
// the file.
// Returns exception, if any.
    Module.prototype._compile = function (content, filename) {
        // Remove shebang
        var contLen = content.length;
        if (contLen >= 2) {
            if (content.charCodeAt(0) === 35/*#*/ &&
                content.charCodeAt(1) === 33/*!*/) {
                if (contLen === 2) {
                    // Exact match
                    content = '';
                } else {
                    // Find end of shebang line and slice it off
                    var i = 2;
                    for (; i < contLen; ++i) {
                        var code = content.charCodeAt(i);
                        if (code === 10/*\n*/ || code === 13/*\r*/)
                            break;
                    }
                    if (i === contLen)
                        content = '';
                    else {
                        // Note that this actually includes the newline character(s) in the
                        // new output. This duplicates the behavior of the regular expression
                        // that was previously used to replace the shebang line
                        content = content.slice(i);
                    }
                }
            }
        }

        // create wrapper function
        var wrapper = Module.wrap(content);

        var compiledWrapper;
        if (userOptions.useSandbox && sandbox) {

            if (!vm.isContext(sandbox)) vm.createContext(sandbox);
            compiledWrapper = vm.runInContext(wrapper, sandbox,{
                filename: filename,
                lineOffset: 0,
                displayErrors: true
            });
        } else {

            compiledWrapper = vm.runInThisContext(wrapper, {
                filename: filename,
                lineOffset: 0,
                displayErrors: true
            });
        }

        var dirname = path.dirname(filename);
        var require = internalModule.makeRequireFunction.call(this);
        var args = [this.exports, require, this, filename, dirname];
        var depth = internalModule.requireDepth;
        if (depth === 0) stat.cache = new Map();
        var result = compiledWrapper.apply(this.exports, args);
        if (depth === 0) stat.cache = null;
        return result;
    };


// Native extension for .js
    Module._extensions['.js'] = function (module, filename) {
        var content = fs.readFileSync(filename, 'utf8');
        module._compile(internalModule.stripBOM(content), filename);
    };


// Native extension for .json
    Module._extensions['.json'] = function (module, filename) {
        var content = fs.readFileSync(filename, 'utf8');
        try {
            module.exports = JSON.parse(internalModule.stripBOM(content));
        } catch (err) {
            err.message = filename + ': ' + err.message;
            throw err;
        }
    };


//Native extension for .node
    Module._extensions['.node'] = function (module, filename) {
        return process.dlopen(module, path._makeLong(filename));
    };


    Module._initPaths = function () {
        const isWindows = process.platform === 'win32';

        var homeDir;
        if (isWindows) {
            homeDir = process.env.USERPROFILE;
        } else {
            homeDir = process.env.HOME;
        }

        var paths = [path.resolve(process.execPath, '..', '..', 'lib', 'node')];

        if (homeDir) {
            paths.unshift(path.resolve(homeDir, '.node_libraries'));
            paths.unshift(path.resolve(homeDir, '.node_modules'));
        }

        var nodePath = process.env['NODE_PATH'];
        if (nodePath) {
            paths = nodePath.split(path.delimiter).filter(function (path) {
                return !!path;
            }).concat(paths);
        }

        modulePaths = paths;

        // clone as a read-only copy, for introspection.
        Module.globalPaths = modulePaths.slice(0);
    };

    Module._initPaths();


//----- Apply New Extensions ----

    var extentionList = userOptions._extensions;
    for (var ext in extentionList) {

        Module._extensions[ext] = function (module, filename) {

            var source = stripBOM(fs.readFileSync(filename, 'utf8'));
            if (extentionList[ext].every(function (method) {
                    var userResult = null;
                    userResult = method(source, filename);

                    if (!userResult || userResult === null) userResult = source;

                    if (!util.isString(userResult)) {   // stop operation, return this value
                        module.exports = userResult;
                        return false;
                    } else {
                        source = userResult;   // set the newly set ret value
                        return true;
                    }
                })) module._compile(source, filename);
        };
    }

//------ Apply New Search Paths
    var paths = userOptions._pathList;

    if (paths.length > 0) {

        var nodePath = process.env['NODE_PATH'];
        var DefaultPaths = process.env['NODE_PATH'];
        if (!nodePath) nodePath = ""; else nodePath += path.delimiter;
        for (var i = 0; i < paths.length; i++) {
            nodePath += paths[i] + path.delimiter;
        }
        process.env['NODE_PATH'] = nodePath;
        Module._initPaths();
        process.env['NODE_PATH'] = DefaultPaths;
    }

//---- End Apply New Paths
    function resolve(request) {
        return Module._resolveFilename(request, self);
    }
    var res = Module.prototype.require;
    res.resolve = resolve;
    res.main = process.mainModule;
    res.extensions = Module._extensions;
    res.cache = Module._cache;

    return res;
}
//*********************************************************************************************





//use event Objects as main exports object, and add required functions
var userOptions = new options();
events.options = userOptions;
events.getAdvanceRequire = buildCustomRequire;


events.upgradeNodeRequire = function(sandbox) {
    NodeDefaultMethods.require = NodeModule.prototype.require;
    NodeModule.prototype.require = buildCustomRequire(sandbox);
}
events.restoreNodeRequire = function() {
    if (NodeDefaultMethods.require)
        NodeModule.prototype.require = NodeDefaultMethods.require;
}

module.exports = events;