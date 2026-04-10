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
      mode:           'msgpack' // 'msgpack' or 'json'
    };

    $scope.ui = {
      newListenerName: ''
    };
    $scope.listeners       = [];
    $scope._logId          = 0;
    $scope.log             = [];

    /* ─── Config ─── */
    const EVENT_TEMPLATES = {
      'chat:room:join': '{\n  "conId": ""\n}',
      'message:send':   '{\n  "conId": "",\n  "msg": ""\n}',
      'typing:start':   '{\n  "conId": ""\n}',
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
      if (EVENT_TEMPLATES[eventName] && (!$scope.emit.payloadJson || !$scope.emit.payloadJson.trim())) {
        $scope.emit.payloadJson = EVENT_TEMPLATES[eventName];
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
        var bytes  = Array.from(packed);
        $scope.emit.jsonError      = '';
        $scope.emit.encodedPreview = bytes;
        $scope.emit.encodedHex     = bytes.map(function (b) {
          return ('00' + b.toString(16)).slice(-2).toUpperCase();
        }).join(' ');
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

      if (raw) {
        try {
          payload = JSON.parse(raw);
          // If mode is msgpack, encode as MessagePack array
          if ($scope.emit.mode === 'msgpack') {
            var packed = msgpack.encode(payload);
            payload = Array.from(new Uint8Array(packed));
          }
        } catch (e) {
          $scope.emit.jsonError = e.message;
          return;
        }
      } else {
        if ($scope.emit.mode === 'json') {
          payload = null;
        } else {
          payload = Array.from(new Uint8Array(msgpack.encode(null)));
        }
      }

      var mode = $scope.emit.mode === 'json' ? 'Plain JSON' : 'MsgPack Array';
      console.log(`[Emit] Event: ${$scope.emit.eventName} (${mode})`, payload);
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

      var prettyStr = _syntaxHighlight(JSON.stringify(decoded, null, 2));

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

      // Limit log to 200 entries
      if ($scope.log.length > 200) { $scope.log.pop(); }

      $timeout(function () { entry.isNew = false; }, 800);
    }

    $scope.clearLog = function () { $scope.log = []; };

    /* ─── JSON Syntax Highlight ─── */
    function _syntaxHighlight(json) {
      if (typeof json !== 'string') { json = JSON.stringify(json, null, 2); }
      json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return json.replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        function (match) {
          var cls = 'json-num';
          if (/^"/.test(match)) {
            cls = /:$/.test(match) ? 'json-key' : 'json-str';
          } else if (/true|false/.test(match)) {
            cls = 'json-bool';
          } else if (/null/.test(match)) {
            cls = 'json-null';
          }
          return '<span class="' + cls + '">' + match + '</span>';
        }
      );
    }

  }]);
