const loaderUtils = require('loader-utils');

module.exports.pitch = function pitch(remainingRequest) {
  const { globals = undefined, pre = [], post = [] } = loaderUtils.getOptions(this) || {};

  return [
    ...(globals
      ? Object.keys(globals).map((key) => `self[${JSON.stringify(key)}] = ${globals[key]};`)
      : []
    ),
    ...pre.map((include) => `require(${loaderUtils.stringifyRequest(this, include)});`),
    `module.exports = require(${loaderUtils.stringifyRequest(this, `!!${remainingRequest}`)});`,
    ...post.map((include) => `require(${loaderUtils.stringifyRequest(this, include)});`),
  ].join('\n');
};
