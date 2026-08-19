angular.module('socketTester', ['ngSanitize'])

  // Filter: format byte as 2-char hex
  .filter('hexByte', function () {
    return function (b) {
      return ('00' + (b & 0xff).toString(16)).slice(-2).toUpperCase();
    };
  })

  .controller('MainCtrl', ['$scope', '$timeout', '$sce', function ($scope, $timeout, $sce) {

    /* ─── State ─── */
    $scope.serverUrl   = 'http://localhost:3001';
    $scope.connected   = false;
    $scope.connecting  = false;   
    $scope.connError   = '';

    $scope.emit = {
      eventName:      '',
      payloadJson:    '',
      jsonError:      '',
      encodedPreview: [],
      encodedHex:     '', 
      lastSent:       '', 
      mode:           'msgpack', // 'msgpack' or 'json'
      rustType:       'bytes'    // 'vec_u8' or 'bytes' (only relevant when mode === 'msgpack')
    };
      
    $scope.ui = {
      newListenerName: '',
      savedEventsSearch: '',
      logSearch: ''
    };
    $scope.listeners       = [];
    $scope._logId          = 0;
    $scope.log             = [];

    $scope.savedEvents = [];
    $scope.savedEventForm = {
      name: '',
      payload: '',
      mode: 'msgpack',
      rustType: 'bytes',
      error: ''
    };
    $scope.editingId = null;

    /* ─── HTTP State ─── */
    $scope.http = {
      method: 'POST',
      url: '',
      format: 'msgpack',     // request body: 'json', 'msgpack' or 'arrow'
      respFormat: 'auto',    // response decoder: 'auto', 'json', 'msgpack' or 'arrow'
      arrowIpc: 'file',      // 'file' (ARROW1 magic) or 'stream' — only used when format === 'arrow'
      contentType: 'application/x-msgpack',
      headersJson: '',
      headersError: '',
      payloadJson: '',
      jsonError: '',
      encodedBytes: null,
      encodedPreview: [],
      encodedHex: '',
      arrowInfo: null,
      loading: false,
      response: null
    };

    /* ─── Config ─── */
    const EVENT_TEMPLATES = {
      'chat:room:join': '{\n  "chatroomId": ""\n}',
      'message:send':   '{\n  "conId": "",\n  "msg": ""\n}',
      'chat:msg:typing':   '{\n  "conId": "",\n  "userId": ""\n "typingStatus" : "" \n}',
      'typing:stop':    '{\n  "conId": ""\n}'
    };


    let socket = null; 

    /* ─── Connection ─── */
    $scope.connect = function () {
      $scope.connError  = '';
      $scope.connecting = true;

      try {
        socket = io($scope.serverUrl, {
          transports:        ['websocket', 'polling'],
          reconnection:      false,
          timeout:           5000,
          forceNew:          true
        });
      } catch (e) {
        $scope.connError  = 'Failed to create socket: ' + e.message;
        $scope.connecting = false;
        $scope.$applyAsync();
        return;
      }

      socket.on('connect', function () {
        $timeout(function () {
          $scope.connected  = true;
          $scope.connecting = false;
          $scope.connError  = '';
          // Re-attach listeners that were added before connection
          $scope.listeners.forEach(function (l) { _attachListener(l); });
        });
      });

      socket.on('connect_error', function (err) {
        $timeout(function () {
          $scope.connecting = false;
          $scope.connected  = false;
          $scope.connError  = 'Connection failed: ' + (err.message || err);
        });
      });

      socket.on('disconnect', function (reason) {
        $timeout(function () {
          $scope.connected  = false;
          $scope.connecting = false;
          $scope.connError  = 'Disconnected: ' + reason;
        });
      });
    };

    $scope.disconnect = function () {
      if (socket) { socket.disconnect(); socket = null; }
      $scope.connected  = false;
      $scope.connecting = false;
    };

    /* ─── JSON validation & live encode preview ─── */
    $scope.validateJson = function () {
      const eventName = ($scope.emit.eventName || '').trim();
      
      // Auto-fill template if empty and we have a template for this event
      if (!$scope.emit.payloadJson || !$scope.emit.payloadJson.trim()) {
        var matched = $scope.savedEvents.find(function(e) { return e.name === eventName; });
        if (matched) {
          $scope.emit.payloadJson = matched.payload;
          if (matched.mode) $scope.emit.mode = matched.mode;
          if (matched.rustType) $scope.emit.rustType = matched.rustType;
        } else if (EVENT_TEMPLATES[eventName]) {
          $scope.emit.payloadJson = EVENT_TEMPLATES[eventName];
        }
      }

      var raw = ($scope.emit.payloadJson || '').trim();
      if (!raw) {
        $scope.emit.jsonError      = '';
        $scope.emit.encodedPreview = [];
        $scope.emit.encodedHex     = '';
        return;
      }

      try {
        var obj = JSON.parse(raw);
        
        // Check if manual mode is set to JSON
        if ($scope.emit.mode === 'json') {
          $scope.emit.jsonError      = '';
          $scope.emit.encodedPreview = [];
          $scope.emit.encodedHex     = 'Mode: Plain JSON';
          return;
        }

        var packed = msgpack.encode(obj);
        var bytes  = Array.from(new Uint8Array(packed));
        $scope.emit.jsonError      = '';
        $scope.emit.encodedPreview = bytes;
        var rustType = $scope.emit.rustType || 'bytes';
        $scope.emit.encodedHex     = bytes.map(function (b) {
          return ('00' + b.toString(16)).slice(-2).toUpperCase();
        }).join(' ');
        // Label differs by rust type
        $scope.emit.encodedTypeLabel = (rustType === 'bytes')
          ? 'Rust Bytes (binary Buffer)'
          : 'Rust Vec<u8> (JSON array of numbers)';
      } catch (e) {
        $scope.emit.jsonError      = e.message;
        $scope.emit.encodedPreview = [];
        $scope.emit.encodedHex     = '';
      }
    };

    /* ─── Emit ─── */
    $scope.emitEvent = function () {
      if (!socket || !$scope.connected) return;
      if (!$scope.emit.eventName)       return;

      var raw = $scope.emit.payloadJson.trim();
      var payload;

      var rustType = $scope.emit.rustType || 'bytes';

      if (raw) {
        try {
          payload = JSON.parse(raw);
          if ($scope.emit.mode === 'msgpack') {
            var packed = msgpack.encode(payload);
            if (rustType === 'bytes') {
              // Send as raw binary Buffer (Rust Bytes type)
              payload = new Uint8Array(packed).buffer;
            } else {
              // Send as JSON array of numbers (Rust Vec<u8>)
              payload = Array.from(new Uint8Array(packed));
            }
          }
        } catch (e) {
          $scope.emit.jsonError = e.message;
          return;
        }
      } else {
        if ($scope.emit.mode === 'json') {
          payload = null;
        } else {
          var emptyPacked = msgpack.encode(null);
          if (rustType === 'bytes') {
            payload = new Uint8Array(emptyPacked).buffer;
          } else {
            payload = Array.from(new Uint8Array(emptyPacked));
          }
        }
      }

      var modeLabel = $scope.emit.mode === 'json' ? 'Plain JSON'
                    : (rustType === 'bytes' ? 'MsgPack → Bytes (Buffer)' : 'MsgPack → Vec<u8> (Array)');
      console.log(`[Emit] Event: ${$scope.emit.eventName} (${modeLabel})`, payload);
      socket.emit($scope.emit.eventName, payload);

      var ts = new Date().toLocaleTimeString('en-GB', { hour12: false }) +
               '.' + String(new Date().getMilliseconds()).padStart(3, '0');
      $scope.emit.lastSent = $scope.emit.eventName + ' @ ' + ts;

      $timeout(function () { $scope.emit.lastSent = ''; }, 3000);
    };

    /* ─── Listeners ─── */
    $scope.addListener = function () {
      var name = ($scope.ui.newListenerName || '').trim();
      console.log('[Listeners] Attempting to add:', name);
      if (!name) return;

      // Check if already exists
      var exists = false;
      for (var i = 0; i < $scope.listeners.length; i++) {
        if ($scope.listeners[i].name === name) {
          exists = true;
          break;
        }
      }

      if (exists) {
        console.warn('[Listeners] Already listening for:', name);
        $scope.ui.newListenerName = '';
        return;
      }

      var listener = { name: name, active: false, count: 0, _handler: null };
      $scope.listeners.push(listener);
      $scope.ui.newListenerName = '';
      
      console.log('[Listeners] Added successfully. Total listeners:', $scope.listeners.length);
      
      if ($scope.connected && socket) { 
        _attachListener(listener); 
      }
    };



    function _attachListener(listener) {
      if (listener._handler) {
        try { socket.off(listener.name, listener._handler); } catch (e) {}
      }
      listener._handler = function (data) {
        $timeout(function () {
          listener.active = true;
          listener.count++;
          _addLogEntry(listener.name, data);
          $timeout(function () { listener.active = false; }, 600);
        });
      };
      socket.on(listener.name, listener._handler);
    }

    $scope.removeListener = function (listener) {
      if (socket && listener._handler) {
        try { socket.off(listener.name, listener._handler); } catch (e) {}
      }
      var idx = $scope.listeners.indexOf(listener);
      if (idx !== -1) { $scope.listeners.splice(idx, 1); }
    };

    /* ─── Log ─── */
    function _addLogEntry(eventName, data) {
      var wasMsgpack = false;
      var rawBytes   = [];
      var decoded;

      // Handle binary data (ArrayBuffer/Uint8Array)
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        var arr = data instanceof Uint8Array ? data : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
        rawBytes = Array.from(arr);
        try {
          decoded = msgpack.decode(arr);
          wasMsgpack = true;
        } catch (e) {
          decoded = { _error: 'MsgPack decode failed', _raw: data };
        }
      } 
      // Handle Socket.IO Buffer wrapper
      else if (typeof data === 'object' && data !== null && data.type === 'Buffer' && Array.isArray(data.data)) {
        rawBytes = data.data;
        try {
          decoded = msgpack.decode(new Uint8Array(rawBytes));
          wasMsgpack = true;
        } catch (e) {
          decoded = { _error: 'MsgPack decode failed', _raw: rawBytes };
        }
      } 
      // Handle Array of numbers (e.g. from Rust JSON array representation of Vec<u8>)
      else if (Array.isArray(data) && (data.length === 0 || typeof data[0] === 'number')) {
        rawBytes = data;
        try {
          decoded = msgpack.decode(new Uint8Array(rawBytes));
          wasMsgpack = true;
        } catch (e) {
          // If msgpack decode fails, it's probably just a regular JSON array of numbers
          decoded = data;
          wasMsgpack = false;
        }
      }
      // Handle plain JSON or strings
      else {
        decoded = data;
        try {
          var str = (typeof data === 'string') ? data : JSON.stringify(data);
          rawBytes = Array.from(new TextEncoder().encode(str));
        } catch (e) {}
      }

      var prettyStr = _renderJson(decoded);

      var entry = {
        id:         ++$scope._logId,
        event:      eventName,
        ts:         new Date(),
        wasMsgpack: wasMsgpack,
        rawBytes:   rawBytes,
        decoded:    decoded,
        prettyJson: $sce.trustAsHtml(prettyStr),
        isNew:      true
      };

      $scope.log.unshift(entry);
      if ($scope.log.length > 200) { $scope.log.pop(); }
      $timeout(function () { entry.isNew = false; }, 800);
    }

    $scope.clearLog = function () {
      $scope.log = [];
    };

    $scope.copyToClipboard = function(data, event) {
      if (!data) return;
      var str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      navigator.clipboard.writeText(str).then(function() {
        if (event && event.target) {
          var btn = event.target;
          var originalText = btn.innerText;
          btn.innerText = 'COPIED!';
          btn.classList.add('copied');
          setTimeout(function() {
            btn.innerText = originalText;
            btn.classList.remove('copied');
          }, 2000);
        }
      }).catch(function(err) {
        console.error('Failed to copy: ', err);
      });
    };

    /* ─── Apache Arrow (IPC) ─── */
    var ARROW_CONTENT_TYPES = {
      file:   'application/vnd.apache.arrow.file',
      stream: 'application/vnd.apache.arrow.stream'
    };

    // Content-Types this app sets on its own — anything else was typed by hand and must not be clobbered.
    var MANAGED_CONTENT_TYPES = [
      'application/json',
      'application/x-msgpack',
      'application/msgpack',
      ARROW_CONTENT_TYPES.file,
      ARROW_CONTENT_TYPES.stream
    ];

    // Accept follows whatever the response decoder is set to, so the server is asked
    // for the format we are actually prepared to read.
    var ACCEPT_HEADERS = {
      auto:    'application/vnd.apache.arrow.file, application/vnd.apache.arrow.stream, ' +
               'application/msgpack, application/x-msgpack, application/json',
      arrow:   'application/vnd.apache.arrow.file, application/vnd.apache.arrow.stream',
      msgpack: 'application/msgpack, application/x-msgpack',
      json:    'application/json'
    };

    function _arrowLoaded() {
      return typeof Arrow !== 'undefined' && Arrow && typeof Arrow.tableFromJSON === 'function';
    }

    // Arrow is columnar: it needs a JSON array of row objects. A lone object is sent as one row.
    function _arrowRows(obj) {
      var rows = Array.isArray(obj) ? obj : [obj];
      if (!rows.length) throw new Error('Arrow needs at least one row — the payload array is empty');
      rows.forEach(function (row, i) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) {
          throw new Error('Arrow needs tabular data — row ' + i + ' is not a JSON object');
        }
      });
      return rows;
    }

    function _arrowEncode(obj, ipc) {
      if (!_arrowLoaded()) throw new Error('Apache Arrow failed to load — check the CDN script tag');
      var rows  = _arrowRows(obj);
      var table = Arrow.tableFromJSON(rows);
      return {
        table:   table,
        bytes:   Arrow.tableToIPC(table, ipc === 'stream' ? 'stream' : 'file'),
        dropped: _droppedColumns(rows, table)
      };
    }

    // tableFromJSON can't infer a type for a column that is null in every row, so it
    // silently drops it. Surface that instead of letting the payload quietly shrink.
    function _droppedColumns(rows, table) {
      var kept = table.schema.fields.map(function (f) { return f.name; });
      var seen = [];
      rows.forEach(function (row) {
        Object.keys(row).forEach(function (k) {
          if (kept.indexOf(k) === -1 && seen.indexOf(k) === -1) seen.push(k);
        });
      });
      return seen;
    }

    function _arrowSchema(table, dropped) {
      return {
        numRows: table.numRows,
        numCols: table.numCols,
        dropped: dropped || [],
        fields: table.schema.fields.map(function (f) {
          return { name: f.name, type: String(f.type), nullable: !!f.nullable };
        })
      };
    }

    // Arrow hands back BigInt / Date / Vector values that neither JSON.stringify nor the
    // pretty renderer can take — flatten everything to plain JSON first.
    function _plainify(val, depth) {
      depth = depth || 0;
      if (depth > 64) return String(val);
      if (val === null || val === undefined)  return null;
      if (typeof val === 'bigint')            return val.toString();
      if (val instanceof Date)                return val.toISOString();
      if (ArrayBuffer.isView(val))            return Array.from(val, function (v) { return _plainify(v, depth + 1); });
      if (Array.isArray(val))                 return val.map(function (v) { return _plainify(v, depth + 1); });
      if (typeof val !== 'object')            return val;
      if (typeof val.toJSON === 'function')   return _plainify(val.toJSON(), depth + 1);
      if (typeof val.toArray === 'function')  return Array.from(val.toArray(), function (v) { return _plainify(v, depth + 1); });
      var out = {};
      Object.keys(val).forEach(function (k) { out[k] = _plainify(val[k], depth + 1); });
      return out;
    }

    // IPC magic: "ARROW1" starts the file format, a 0xFFFFFFFF continuation starts the stream format.
    function _detectArrow(u8) {
      if (u8.length < 8) return '';
      if (u8[0] === 0x41 && u8[1] === 0x52 && u8[2] === 0x52 &&
          u8[3] === 0x4f && u8[4] === 0x57 && u8[5] === 0x31) return 'file';
      if (u8[0] === 0xff && u8[1] === 0xff && u8[2] === 0xff && u8[3] === 0xff) return 'stream';
      return '';
    }

    function _arrowDecode(u8) {
      var table = Arrow.tableFromIPC(u8);
      return {
        rows:   table.toArray().map(function (row) { return _plainify(row); }),
        schema: _arrowSchema(table)
      };
    }

    /* ─── Response decoding ─── */
    function _text(u8) {
      return new TextDecoder().decode(u8);
    }

    // A forced decoder that fails is worth reporting — falling back silently would hide
    // the exact mismatch the user picked that format to check for.
    function _decodeFailed(label, err, u8) {
      return {
        as: 'text',
        decodeError: label + ' decode failed: ' + ((err && err.message) || err),
        decoded: _text(u8)
      };
    }

    function _decodeArrowAs(u8) {
      try {
        if (!_arrowLoaded()) throw new Error('Apache Arrow failed to load — check the CDN script tag');
        var kind = _detectArrow(u8);
        if (!kind) throw new Error('body is not Arrow IPC — no ARROW1 or continuation magic');
        var res = _arrowDecode(u8);
        if (!_arrowUsable(res)) throw new Error('no schema could be read from the IPC body');
        return { as: 'arrow', decoded: res.rows, arrowInfo: res.schema, arrowIpc: kind };
      } catch (e) {
        return _decodeFailed('Arrow', e, u8);
      }
    }

    // tableFromIPC hands back an empty 0-column table for input it cannot parse rather
    // than throwing, so an absent schema is how a failed decode actually shows up.
    // A real table with zero *rows* is fine — an empty result set still carries a schema.
    function _arrowUsable(res) {
      return !!(res && res.schema && res.schema.numCols);
    }

    function _decodeMsgpackAs(u8) {
      try {
        return { as: 'msgpack', decoded: msgpack.decode(u8) };
      } catch (e) {
        return _decodeFailed('MessagePack', e, u8);
      }
    }

    function _decodeJsonAs(u8) {
      try {
        return { as: 'json', decoded: JSON.parse(_text(u8)) };
      } catch (e) {
        return _decodeFailed('JSON', e, u8);
      }
    }

    function _decodeResponse(u8, want) {
      if (u8.length === 0) return { as: 'empty', decoded: { _info: 'Empty response' } };

      if (want === 'arrow')   return _decodeArrowAs(u8);
      if (want === 'msgpack') return _decodeMsgpackAs(u8);
      if (want === 'json')    return _decodeJsonAs(u8);

      // 'auto': Arrow has to be tried first — msgpack would happily read the leading
      // 'A' of ARROW1 as a positive fixint and report a bogus success.
      var kind = _detectArrow(u8);
      if (kind && _arrowLoaded()) {
        try {
          var res = _arrowDecode(u8);
          if (_arrowUsable(res)) {
            return { as: 'arrow', decoded: res.rows, arrowInfo: res.schema, arrowIpc: kind };
          }
        } catch (e) {
          // Magic matched but the body isn't valid Arrow — keep going.
        }
      }
      try { return { as: 'msgpack', decoded: msgpack.decode(u8) }; } catch (e) {}
      try { return { as: 'json',    decoded: JSON.parse(_text(u8)) }; } catch (e) {}
      return { as: 'text', decoded: _text(u8) };
    }

    /* ─── HTTP API Tester ─── */
    $scope.setHttpFormat = function (format, ipc) {
      $scope.http.format = format;
      if (ipc) { $scope.http.arrowIpc = ipc; }
      if (!$scope.http.contentType || MANAGED_CONTENT_TYPES.indexOf($scope.http.contentType) !== -1) {
        $scope.http.contentType = _defaultContentType();
      }
      $scope.validateHttpJson();
    };

    $scope.setHttpRespFormat = function (respFormat) {
      $scope.http.respFormat = respFormat;
    };

    function _defaultContentType() {
      if ($scope.http.format === 'arrow') {
        return ARROW_CONTENT_TYPES[$scope.http.arrowIpc] || ARROW_CONTENT_TYPES.file;
      }
      return ($scope.http.format === 'json') ? 'application/json' : 'application/x-msgpack';
    }

    $scope.httpResponseLabel = function () {
      var as = $scope.http.response && $scope.http.response.decodedAs;
      if (as === 'arrow')   return 'DECODED ROWS (ARROW)';
      if (as === 'msgpack') return 'DECODED JSON (MSGPACK)';
      if (as === 'json')    return 'RESPONSE JSON';
      return 'RESPONSE DATA';
    };

    function _clearHttpEncoded() {
      $scope.http.encodedBytes   = null;
      $scope.http.encodedPreview = [];
      $scope.http.encodedHex     = '';
      $scope.http.arrowInfo      = null;
    }

    $scope.validateHttpJson = function() {
      var raw = ($scope.http.payloadJson || '').trim();
      _clearHttpEncoded();
      if (!raw) {
        $scope.http.jsonError = '';
        return;
      }
      try {
        var obj = JSON.parse(raw);
        var bytes;

        if ($scope.http.format === 'arrow') {
          var enc = _arrowEncode(obj, $scope.http.arrowIpc);
          bytes = enc.bytes;
          $scope.http.arrowInfo = _arrowSchema(enc.table, enc.dropped);
        } else if ($scope.http.format === 'json') {
          // Re-serialised rather than sent verbatim, so the byte preview is exactly
          // what goes on the wire.
          bytes = new TextEncoder().encode(JSON.stringify(obj));
        } else {
          bytes = new Uint8Array(msgpack.encode(obj));
        }

        var preview = Array.from(bytes);
        $scope.http.encodedBytes   = bytes;
        $scope.http.encodedPreview = preview;
        // Arrow buffers run to hundreds of bytes even for tiny tables — cap the hex line.
        $scope.http.encodedHex     = preview.slice(0, 64).map(function(b) {
          return ('00' + b.toString(16)).slice(-2).toUpperCase();
        }).join(' ') + (preview.length > 64 ? ' …' : '');
        $scope.http.jsonError      = '';
      } catch(e) {
        $scope.http.jsonError = e.message;
        _clearHttpEncoded();
      }
    };

    $scope.validateHttpHeaders = function() {
      var raw = ($scope.http.headersJson || '').trim();
      if (!raw) {
        $scope.http.headersError = '';
        return;
      }
      try {
        var obj = JSON.parse(raw);
        if (typeof obj !== 'object' || Array.isArray(obj)) {
          $scope.http.headersError = 'Headers must be a JSON object';
        } else {
          $scope.http.headersError = '';
        }
      } catch(e) {
        $scope.http.headersError = e.message;
      }
    };

    $scope.sendHttpRequest = function() {
      if (!$scope.http.url) return;

      var method     = $scope.http.method || 'POST';
      var hasBody    = ['GET', 'HEAD'].indexOf(method) === -1;
      var rawPayload = ($scope.http.payloadJson || '').trim();

      // Re-encode before sending so a stale preview can never be what goes on the wire.
      if (hasBody && rawPayload) {
        $scope.validateHttpJson();
        if ($scope.http.jsonError) return;
      }

      var customHeaders = {};
      var rawHeaders = ($scope.http.headersJson || '').trim();
      if (rawHeaders) {
        try {
          customHeaders = JSON.parse(rawHeaders);
        } catch(e) {
          $scope.http.headersError = 'Invalid headers JSON';
          return;
        }
      }

      $scope.http.loading  = true;
      $scope.http.response = null;

      var reqInit = {
        method: method,
        headers: Object.assign({
          'Content-Type': $scope.http.contentType || _defaultContentType(),
          'Accept': ACCEPT_HEADERS[$scope.http.respFormat] || ACCEPT_HEADERS.auto
        }, customHeaders)
      };

      if (hasBody && rawPayload && $scope.http.encodedBytes) {
        reqInit.body = $scope.http.encodedBytes;
      }

      fetch($scope.http.url, reqInit)
        .then(function(res) {
          var status = res.status;
          return res.arrayBuffer().then(function(buffer) {
            return { status: status, buffer: buffer };
          });
        })
        .then(function(data) {
          $scope.$applyAsync(function() {
            $scope.http.loading = false;
            var u8  = new Uint8Array(data.buffer);
            var out = _decodeResponse(u8, $scope.http.respFormat);

            $scope.http.response = {
              status: data.status,
              ts: new Date(),
              rawBytes: Array.from(u8),
              decodedAs: out.as,
              decodeError: out.decodeError || '',
              arrowInfo: out.arrowInfo || null,
              arrowIpc: out.arrowIpc || '',
              decoded: out.decoded,
              prettyJson: $sce.trustAsHtml(_renderJson(out.decoded))
            };
          });
        })
        .catch(function(err) {
          $scope.$applyAsync(function() {
            $scope.http.loading = false;
            var errInfo = { error: (err && err.message) || String(err) };
            $scope.http.response = {
              status: 'Error',
              ts: new Date(),
              rawBytes: [],
              decodedAs: '',
              decodeError: '',
              arrowInfo: null,
              arrowIpc: '',
              decoded: errInfo,
              prettyJson: $sce.trustAsHtml(_renderJson(errInfo))
            };
          });
        });
    };

    /* ─── Saved Events & Templates ─── */
    $scope.loadSavedEvents = function() {
      var stored = localStorage.getItem('savedEvents');
      if (stored) {
        try {
          $scope.savedEvents = JSON.parse(stored);
        } catch(e) {
          console.error("Failed to parse saved events", e);
          $scope.savedEvents = [];
        }
      } else {
        $scope.savedEvents = [];
      }
    };

    $scope.saveEventsToStorage = function() {
      localStorage.setItem('savedEvents', JSON.stringify($scope.savedEvents));
    };

    $scope.selectSavedEvent = function(event) {
      $scope.emit.eventName = event.name;
      $scope.emit.payloadJson = event.payload;
      if (event.mode) $scope.emit.mode = event.mode;
      if (event.rustType) $scope.emit.rustType = event.rustType;
      $scope.validateJson();
      
      $scope.emit.lastSent = 'Loaded ' + event.name;
      $timeout(function() {
        if ($scope.emit.lastSent === 'Loaded ' + event.name) {
          $scope.emit.lastSent = '';
        }
      }, 2000);
    };

    $scope.applyTemplate = function() {
      if ($scope.ui.selectedTemplate) {
        $scope.selectSavedEvent($scope.ui.selectedTemplate);
        $scope.ui.selectedTemplate = null;
      }
    };

    $scope.clearEmitFields = function() {
      $scope.emit.eventName = '';
      $scope.emit.payloadJson = '';
      $scope.emit.encodedPreview = [];
      $scope.emit.encodedHex = '';
      $scope.emit.jsonError = '';
      $scope.validateJson();
    };

    $scope.validateSavedEventFormJson = function() {
      var raw = ($scope.savedEventForm.payload || '').trim();
      if (!raw) {
        $scope.savedEventForm.error = '';
        return;
      }
      try {
        JSON.parse(raw);
        $scope.savedEventForm.error = '';
      } catch(e) {
        $scope.savedEventForm.error = e.message;
      }
    };

    $scope.saveEvent = function() {
      if (!$scope.savedEventForm.name) return;
      
      var payloadStr = ($scope.savedEventForm.payload || '').trim();
      if (payloadStr) {
        try {
          JSON.parse(payloadStr);
        } catch(e) {
          $scope.savedEventForm.error = 'Invalid JSON: ' + e.message;
          return;
        }
      } else {
        payloadStr = '{}';
      }

      var targetName = $scope.savedEventForm.name.trim();
      var existingIdx = $scope.savedEvents.findIndex(function(e) {
        return e.name.toLowerCase() === targetName.toLowerCase() && (!$scope.editingId || e.id !== $scope.editingId);
      });

      var eventId = $scope.editingId ? $scope.editingId : (existingIdx !== -1 ? $scope.savedEvents[existingIdx].id : 'evt_' + Date.now());

      var eventData = {
        id: eventId,
        name: targetName,
        payload: payloadStr,
        mode: $scope.savedEventForm.mode,
        rustType: $scope.savedEventForm.rustType
      };

      if ($scope.editingId) {
        if (existingIdx !== -1) {
          $scope.savedEvents[existingIdx] = eventData;
          var oldIdx = $scope.savedEvents.findIndex(function(e) { return e.id === $scope.editingId; });
          if (oldIdx !== -1 && oldIdx !== existingIdx) {
            $scope.savedEvents.splice(oldIdx, 1);
          }
        } else {
          var idx = $scope.savedEvents.findIndex(function(e) { return e.id === $scope.editingId; });
          if (idx !== -1) {
            $scope.savedEvents[idx] = eventData;
          }
        }
        $scope.editingId = null;
      } else {
        if (existingIdx !== -1) {
          $scope.savedEvents[existingIdx] = eventData;
        } else {
          $scope.savedEvents.push(eventData);
        }
      }

      $scope.saveEventsToStorage();
      $scope.cancelEdit();
    };

    $scope.editEvent = function(event) {
      $scope.editingId = event.id;
      $scope.savedEventForm.name = event.name;
      $scope.savedEventForm.payload = event.payload;
      $scope.savedEventForm.mode = event.mode || 'msgpack';
      $scope.savedEventForm.rustType = event.rustType || 'bytes';
      $scope.savedEventForm.error = '';
    };

    $scope.deleteEvent = function(event) {
      if (confirm('Are you sure you want to delete this saved event?')) {
        var idx = $scope.savedEvents.indexOf(event);
        if (idx !== -1) {
          $scope.savedEvents.splice(idx, 1);
          $scope.saveEventsToStorage();
          if ($scope.editingId === event.id) {
            $scope.cancelEdit();
          }
        }
      }
    };

    $scope.cancelEdit = function() {
      $scope.editingId = null;
      $scope.savedEventForm = {
        name: '',
        payload: '',
        mode: 'msgpack',
        rustType: 'bytes',
        error: ''
      };
    };

    $scope.saveCurrentToSavedEvents = function() {
      if (!$scope.emit.eventName) return;
      var payloadStr = ($scope.emit.payloadJson || '').trim();
      if (payloadStr) {
        try {
          JSON.parse(payloadStr);
        } catch(e) {
          alert("Cannot save event: Invalid JSON payload.");
          return;
        }
      } else {
        payloadStr = '{}';
      }
      
      var targetName = $scope.emit.eventName.trim();
      var existingIdx = $scope.savedEvents.findIndex(function(e) {
        return e.name.toLowerCase() === targetName.toLowerCase();
      });

      var newEvt = {
        id: existingIdx !== -1 ? $scope.savedEvents[existingIdx].id : 'evt_' + Date.now(),
        name: targetName,
        payload: payloadStr,
        mode: $scope.emit.mode || 'msgpack',
        rustType: $scope.emit.rustType || 'bytes'
      };

      if (existingIdx !== -1) {
        $scope.savedEvents[existingIdx] = newEvt;
      } else {
        $scope.savedEvents.push(newEvt);
      }
      $scope.saveEventsToStorage();
      
      $scope.emit.lastSent = 'Saved to Templates!';
      $timeout(function () { if ($scope.emit.lastSent === 'Saved to Templates!') $scope.emit.lastSent = ''; }, 2000);
    };

    // Load saved events initially
    $scope.loadSavedEvents();


    /* ─── JSON Collapsible Renderer ──────────────── */
    function _renderJson(val) {
      if (val === null) return '<span class="json-null">null</span>';
      if (typeof val === 'number') return '<span class="json-num">' + val + '</span>';
      if (typeof val === 'boolean') return '<span class="json-bool">' + val + '</span>';
      if (typeof val === 'string') {
        var escaped = val.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '\\"');
        return '<span class="json-str">"' + escaped + '"</span>';
      }

      var isArray = Array.isArray(val);
      var keys = isArray ? val : Object.keys(val);
      if (keys.length === 0) {
        return '<span class="json-brace">' + (isArray ? '[]' : '{}') + '</span>';
      }

      var html = '<span class="json-group">';
      html += '<span class="json-toggle"></span>';
      html += '<span class="json-brace">' + (isArray ? '[' : '{') + '</span>';
      html += '<span class="json-placeholder" title="Click to expand"> ... </span>';
      html += '<div class="json-collapsible">';

      if (isArray) {
        val.forEach(function (item, i) {
          var canCollapse = (typeof item === 'object' && item !== null && Object.keys(item).length > 0);
          html += '<div class="json-line' + (canCollapse ? ' json-has-toggle' : '') + '">';
          html += _renderJson(item);
          if (i < val.length - 1) html += '<span class="json-comma">,</span>';
          html += '</div>';
        });
      } else {
        var objKeys = Object.keys(val);
        objKeys.forEach(function (key, i) {
          var item = val[key];
          var canCollapse = (typeof item === 'object' && item !== null && Object.keys(item).length > 0);
          html += '<div class="json-line' + (canCollapse ? ' json-has-toggle' : '') + '">';
          html += '<span class="json-key">"' + key + '"</span><span class="json-brace">: </span>' + _renderJson(item);
          if (i < objKeys.length - 1) html += '<span class="json-comma">,</span>';
          html += '</div>';
        });
      }

      html += '</div>';
      html += '<span class="json-brace">' + (isArray ? ']' : '}') + '</span>';
      html += '</span>';
      return html;
    }

    // Global click listener for toggling JSON
    document.addEventListener('click', function (e) {
      var toggle = e.target.closest('.json-toggle');
      var placeholder = e.target.closest('.json-placeholder');
      if (toggle || placeholder) {
        var group = (toggle || placeholder).parentElement;
        group.classList.toggle('json-collapsed');
        e.stopPropagation();
      }
    });

  }]);
