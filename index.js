const path = require('path');
const webpack = require('webpack');
const AddWorkerEntryPointPlugin = require('./plugins/AddWorkerEntryPointPlugin');
const INCLUDE_LOADER_PATH = require.resolve('./loaders/include');

const EDITOR_MODULE = {
  label: 'editorWorkerService',
  entry: undefined,
  worker: {
    id: 'vs/editor/editor',
    entry: 'vs/editor/editor.worker',
    output: 'editor.worker.js',
    fallback: undefined
  },
  alias: undefined,
};
const LANGUAGES = require('./languages');
const FEATURES = require('./features');

function resolveMonacoPath(filePath) {
  return require.resolve(path.join('monaco-editor/esm', filePath));
}

const languagesById = fromPairs(
  flatMap(toPairs(LANGUAGES), ([id, language]) =>
    [id].concat(language.alias || []).map((label) => [label, mixin({ label }, language)])
  )
);
const featuresById = mapValues(FEATURES, (feature, key) => mixin({ label: key }, feature))

function getFeaturesIds(userFeatures, predefinedFeaturesById) {
  function notContainedIn(arr) {
    return (element) => arr.indexOf(element) === -1;
  }

  let featuresIds;

  if (userFeatures.length) {
    const excludedFeatures = userFeatures.filter(f => f[0] === '!').map(f => f.slice(1));
    if (excludedFeatures.length) {
      featuresIds = Object.keys(predefinedFeaturesById).filter(notContainedIn(excludedFeatures))
    } else {
      featuresIds = userFeatures;
    }
  } else {
    featuresIds = Object.keys(predefinedFeaturesById);
  }

  return featuresIds;
}

class MonacoWebpackPlugin {
  constructor(options = {}) {
    const languages = options.languages || Object.keys(languagesById);
    const features = getFeaturesIds(options.features || [], featuresById);
    const output = options.output || '';
    const worker = Object.assign(
      { inline: false },
      options.worker
    );
    this.options = {
      languages: languages.map((id) => languagesById[id]).filter(Boolean),
      features: features.map(id => featuresById[id]).filter(Boolean),
      output,
      worker,
    };
  }

  apply(compiler) {
    const { languages, features, output, worker } = this.options;
    const publicPath = getPublicPath(compiler);
    const modules = [EDITOR_MODULE].concat(languages).concat(features);
    const workers = modules.map(
      ({ label, alias, worker }) => worker && (mixin({ label, alias }, worker))
    ).filter(Boolean);
    const rules = createLoaderRules(languages, features, workers, output, publicPath, worker.inline);
    const plugins = createPlugins(workers, output);
    addCompilerRules(compiler, rules);
    addCompilerPlugins(compiler, plugins);
  }
}

function addCompilerRules(compiler, rules) {
  const compilerOptions = compiler.options;
  const moduleOptions = compilerOptions.module || (compilerOptions.module = {});
  moduleOptions.rules = (moduleOptions.rules || []).concat(rules);
}

function addCompilerPlugins(compiler, plugins) {
  plugins.forEach((plugin) => plugin.apply(compiler));
}

function getPublicPath(compiler) {
  // Use a relative path if we are production to avoid cross domain issues
  if (process.env.NODE_ENV === "production") return "";
  return compiler.options.output && compiler.options.output.publicPath || '';
}

function createLoaderRules(languages, features, workers, outputPath, publicPath, inline) {
  if (!languages.length && !features.length) { return []; }
  const languagePaths = flatArr(languages.map(({ entry }) => entry).filter(Boolean));
  const featurePaths = flatArr(features.map(({ entry }) => entry).filter(Boolean));
  const workerPaths = fromPairs(workers.map(({ label, output }) => [label, path.join(outputPath, output)]));
  if (workerPaths['typescript']) {
    // javascript shares the same worker
    workerPaths['javascript'] = workerPaths['typescript'];
  }
  if (workerPaths['css']) {
    // scss and less share the same worker
    workerPaths['less'] = workerPaths['css'];
    workerPaths['scss'] = workerPaths['css'];
  }

  const strStripTrailingSlashFunction = `
    function stripTrailingSlash(str) {
      return str.replace(/\\/$/, '');
    }
  `;
  const getWorkerUrlSnippet = `
    const pathPrefix = (typeof window.__webpack_public_path__ === 'string' ? window.__webpack_public_path__ : ${JSON.stringify(publicPath)});
    const url = (pathPrefix ? stripTrailingSlash(pathPrefix) + '/' : '') + paths[label];
  `;

  if (workerPaths['html']) {
    // handlebars, razor and html share the same worker
    workerPaths['handlebars'] = workerPaths['html'];
    workerPaths['razor'] = workerPaths['html'];
  }

  let globals = {
    'MonacoEnvironment': `(function (paths) {
      ${strStripTrailingSlashFunction}
      return {
        getWorkerUrl: function (moduleId, label) {
          ${getWorkerUrlSnippet}
          return url;
        }
      };
    })(${JSON.stringify(workerPaths, null, 2)})`,
  };
  if (inline) {
    // TODO:
    // getWorker doesn't support asynchronous, so I have to use synchronous XHR.
    // until monaco editor support it
    globals = {
      'MonacoEnvironment':
      `((paths) => ({ getWorker: (workerId, label, cb) => {
        ${strStripTrailingSlashFunction}
        ${getWorkerUrlSnippet}
        function AsyncBlobWorker(url) {
          this._url = url;
          this._actionQueue = [];
          this._getXHRWorker(this._url, (error, worker) => {
            if (error) throw error;
            this._worker = worker;
            this._hookWorker();
          });
        }

        AsyncBlobWorker.prototype._hookWorker = function _hookWorker() {
          this._worker.onerror = (function () {
            if(this.onerror) {
              this.onerror.apply(this, arguments);
            }
          }).bind(this);
          this._worker.onmessage = (function () {
            if(this.onmessage) {
              this.onmessage.apply(this, arguments);
            }
          }).bind(this);
          this._worker.onmessageerror = (function () {
            if(this.onmessageerror) {
              this.onmessageerror.apply(this, arguments);
            }
          }).bind(this);
          this._actionQueue.map(action => {
            if(action.type === 'postMessage') {
              this._worker.postMessage.apply(this._worker, action.arguments);
            }
            if(action.type === 'terminate') {
              this._worker.terminate();
            }
          });
        }

        AsyncBlobWorker.prototype._getXHRWorker = function _getXHRWorker(url, cb) {
          const req = new XMLHttpRequest();
          req.addEventListener('load', function() {
            if (this.status === 200) {
              const worker = new Worker(
                window.URL.createObjectURL(
                  new Blob([this.responseText])
                )
              );
              return cb(null, worker);
            }
            return cb(new Error('Failed to load worker script as blob'));
          });
          req.open('get', url, true)
          req.send();
        }
        AsyncBlobWorker.prototype.postMessage = function postMessage() {
          if(this._worker) return this._worker.postMessage.apply(this._worker, arguments);
          return this._actionQueue.push({
            type: 'postMessage',
            arguments: arguments,
          });
        }
        AsyncBlobWorker.prototype.terminate = function terminate() {
          if(this._worker) return this._worker.terminate();
          return this._actionQueue.push({
            type: 'terminate'
          });
        }
        return new AsyncBlobWorker(url);
      }}))(${
        JSON.stringify(workerPaths, null, 2)
      })
      `
    }
  }
  return [
    {
      test: /monaco-editor[/\\]esm[/\\]vs[/\\]editor[/\\]editor.(api|main).js/,
      use: [
        {
          loader: INCLUDE_LOADER_PATH,
          options: {
            globals,
            pre: featurePaths.map((importPath) => resolveMonacoPath(importPath)),
            post: languagePaths.map((importPath) => resolveMonacoPath(importPath)),
          },
        },
      ],
    },
  ];
}

function createPlugins(workers, outputPath) {
  return (
    []
    .concat(uniqBy(workers, ({ id }) => id).map(({ id, entry, output }) =>
      new AddWorkerEntryPointPlugin({
        id,
        entry: resolveMonacoPath(entry),
        filename: path.join(outputPath, output),
        plugins: [
          new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
        ],
      })
    ))
  );
}

function flatMap(items, iteratee) {
  return items.map(iteratee).reduce((acc, item) => [].concat(acc).concat(item), []);
}

function flatArr(items) {
  return items.reduce((acc, item) => {
    if (Array.isArray(item)) {
      return [].concat(acc).concat(item);
    }
    return [].concat(acc).concat([item]);
  }, []);
}

function toPairs(object) {
  return Object.keys(object).map((key) => [key, object[key]]);
}

function fromPairs(values) {
  return values.reduce((acc, [key, value]) => Object.assign(acc, { [key]: value }), {});
}

function mapValues(object, iteratee) {
  return Object.keys(object).reduce(
    (acc, key) => Object.assign(acc, { [key]: iteratee(object[key], key) }),
    {}
  );
}

function uniqBy(items, iteratee) {
  const keys = {};
  return items.reduce((acc, item) => {
    const key = iteratee(item);
    if (key in keys) { return acc; }
    keys[key] = true;
    acc.push(item);
    return acc;
  }, []);
}

function mixin(dest, src) {
  for (let prop in src) {
    if (Object.hasOwnProperty.call(src, prop)) {
      dest[prop] = src[prop];
    }
  }
  return dest;
}

module.exports = MonacoWebpackPlugin;
