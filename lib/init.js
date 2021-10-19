// https://www.npmjs.com/package/pipestream
// pipestream用于管理stream拼接串，无需按顺序依次pipe stream，且可以通过回调的方式动态插入stream，通过pipestream拼接的stream串可以作为一个对象传递。
var PipeStream = require('pipestream');
var util = require('./util');
var config = require('./config');

var HTTPS_RE = /^https:/i;

function addErrorEvents(req, res) {
  var countdown = function() {
    if (req.isLogRequests) {
      req.isLogRequests = false;
      --util.proc.httpRequests;
      req._hasClosed = true;
      req.emit('_closed');
    }
  };
  var clientReq;
  req.on('dest', function(_req) {
    clientReq = _req;
    if (!req.noReqBody) {
      clientReq.on('error', abort);
    }
  }).on('error', abort);
  res.on('src', function(_res) {
    if (clientReq && req.noReqBody) {
      clientReq.on('error', abort);
    }
    _res.on('error', abort);
  }).on('error', abort)
    .once('close', abort)
      .once('finish', countdown);

  function abort(err) {
    if (clientReq === false) {
      return;
    }
    countdown();
    req._hasError = true;
    clientReq = req._clientReq || clientReq;
    if (clientReq) {
      if (clientReq.destroy) {
        clientReq.destroy();
      } else if (clientReq.abort) {
        clientReq.abort();
      }
      clientReq = false;
    }
    if (req._hasRespond || res._headerSent || !res.writable || (err && (err.code === 'ERR_WHISTLE_ABORTED'))) {
      return res.destroy();
    }
    err = util.getErrorStack(err || 'Closed');
    res.response(util.wrapGatewayError(err));
  }
}

function addTunnelData(socket, headers, key, tempKey) {
  var value = socket[key] || headers[tempKey];
  if (value) {
    delete headers[tempKey];
    socket[key] = headers[key] = value;
  }
}

function addTransforms(req, res) {
  var reqIconvPipeStream, resIconvPipeStream, svrRes, initedResTransform;

  req.addTextTransform = function(transform) {
    if (!reqIconvPipeStream) {
      // reqIconvPipeStream 是个 pipeStream
      reqIconvPipeStream = util.getPipeIconvStream(req.headers);
      initReqZipTransform().add(reqIconvPipeStream);
    }
    reqIconvPipeStream.add(transform);
    return req;
  };

  req.addZipTransform = function(transform, head, tail) {
    initReqZipTransform()[head ? 'addHead' : (tail ? 'addTail' : 'add')](transform);
    return req;
  };

  function initReqZipTransform() {
    if (!req._needGunzip) {
      delete req.headers['content-length'];
      req._needGunzip = true;
    }
    return req;
  }

  function initResZipTransform() {
    if (!initedResTransform) {
      initedResTransform = true;
      res._needGunzip = true;
      removeContentLength();
      res.add(function(src, next) {
        if (resIconvPipeStream) {
          var pipeIconvStream = util.getPipeIconvStream(res.headers);
          pipeIconvStream.add(resIconvPipeStream);
          next(src.pipe(pipeIconvStream));
        } else {
          next(src);
        }
      });
    }
  }

  res.addZipTransform = function(transform, head, tail) {
    initResZipTransform();
    res[head ? 'addHead' : (tail ? 'addTail' : 'add')](transform);
    return res;
  };
  res.addTextTransform = function(transform, head, tail) {
    if (!resIconvPipeStream) {
      resIconvPipeStream = new PipeStream();
      initResZipTransform();
    }
    resIconvPipeStream[head ? 'addHead' : (tail ? 'addTail' : 'add')](transform);
    return res;
  };

  res.on('src', function(_res) {
    svrRes = _res;
    removeContentLength();
  });

  function removeContentLength() {
    if (svrRes && res._needGunzip) {
      delete svrRes.headers['content-length'];
    }
  }
}

module.exports = function(req, res, next) {
  // 把req转为pipeStream
  PipeStream.wrapSrc(req);
  PipeStream.wrapDest(res);
  addTransforms(req, res);
  addErrorEvents(req, res);
  // 下面这句返回的是req.headers[config.PROXY_ID_HEADER]，值例如 'x-whistle-proxy-id-1629379210713-30520-9563'
  req.isPluginReq = util.checkPluginReqOnce(req);
  var headers = req.headers;
  var socket = req.socket || {};
  // 下面这句返回的是req.headers[config.CLIENT_INFO_HEAD]，值例如 ['x-whistle-client-info-1629379210713-30520-9563', '类第一个'],
  var clientInfo = util.parseClientInfo(req);
  // getForwardedFor返回的是ip
  var clientIp = clientInfo[0] || util.getForwardedFor(headers);
  if (clientIp && util.isLocalAddress(clientIp)) {
    delete headers[config.CLIENT_IP_HEAD];
    clientIp = null;
  }
  if (!socket[config.CLIENT_IP_HEAD]) {
    socket[config.CLIENT_IP_HEAD] = clientIp || util.getClientIp(req);
  }
  req.clientIp = clientIp = clientIp || socket[config.CLIENT_IP_HEAD];
  req.method = util.getMethod(req.method); // GET、POST等
  // 返回的是 config.COMPOSER_CLIENT_ID_HEADER = 'x-whistle-client-id-' + uid，值例如 'x-whistle-client-id-' + uid
  req._clientId = util.getComposerClientId(headers);
  // CLIENT_PORT_HEAD: 'x-whistle-client-port'
  var clientPort = clientInfo[1] || headers[config.CLIENT_PORT_HEAD];
  delete headers[config.CLIENT_PORT_HEAD];
  if (!(clientPort > 0)) {
    clientPort = null;
  }
  if (!socket[config.CLIENT_PORT_HEAD]) {
    socket[config.CLIENT_PORT_HEAD] = clientPort || socket.remotePort;
  }
  req.clientPort = clientPort = clientPort || socket[config.CLIENT_PORT_HEAD];
  var isHttps = req.socket.isHttps || headers[config.HTTPS_FIELD] || headers[config.HTTPS_PROTO_HEADER] === 'https';
  if (isHttps) {
    req.isHttps = true;
    delete headers[config.HTTPS_FIELD];
    delete headers[config.HTTPS_PROTO_HEADER];
  }
  if (headers['proxy-connection']) {
    // headers['proxy-connection']的值，比如 'close'、 'keep-alive'等
    headers.connection = headers['proxy-connection'];
  }
  delete headers['proxy-connection'];
  if (!req.isHttps && HTTPS_RE.test(req.url)) {
    req.isHttps = true;
  }
  addTunnelData(socket, headers, config.TEMP_CLIENT_ID_HEADER, config.TEMP_CLIENT_ID_HEADER);
  addTunnelData(socket, headers, config.TUNNEL_DATA_HEADER, config.TEMP_TUNNEL_DATA_HEADER);
  // config.ALPN_PROTOCOL_HEADER = 'x-whistle-alpn-protocol';
  if (headers[config.ALPN_PROTOCOL_HEADER]) {
    if (req.isHttps) {
      req.isH2 = true;
      req.rawHeaders = [];
    }
    delete headers[config.ALPN_PROTOCOL_HEADER];
  }
  res.response = function(_res) {
    if (req._hasRespond) {
      return;
    }
    req._hasRespond = true;
    if (_res.realUrl) {
      req.realUrl = res.realUrl = _res.realUrl;
    }
    res.headers = req.resHeaders = _res.headers;
    // 状态码是100～999之间
    res.statusCode = req.statusCode = _res.statusCode = util.getStatusCode(_res.statusCode);
    // exports.drain = require('./drain');
    util.drain(req, function() {
      if (util.getStatusCode(_res.statusCode)) {
        // ??? res.src是什么东东，没查到啊？？
        res.src(_res);
        res.writeHead(_res.statusCode, _res.headers);
      } else {
        // 返回 502
        util.sendStatusCodeError(res, _res);
      }
    });
  };

  next();
};
