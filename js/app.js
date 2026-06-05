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
      contentType: 'application/x-msgpack',
      headersJson: '',
      headersError: '',
      payloadJson: '',
      jsonError: '',
      encodedBytes: null,
      encodedPreview: [],
      encodedHex: '',
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

    /* ─── HTTP API Tester ─── */
    $scope.validateHttpJson = function() {
      var raw = ($scope.http.payloadJson || '').trim();
      if (!raw) {
        $scope.http.jsonError = '';
        $scope.http.encodedBytes = null;
        $scope.http.encodedPreview = [];
        $scope.http.encodedHex = '';
        return;
      }
      try {
        var obj = JSON.parse(raw);
        $scope.http.encodedBytes = msgpack.encode(obj);
        var bytes = Array.from(new Uint8Array($scope.http.encodedBytes));
        $scope.http.encodedPreview = bytes;
        $scope.http.encodedHex = bytes.map(function(b) {
          return ('00' + b.toString(16)).slice(-2).toUpperCase();
        }).join(' ');
        $scope.http.jsonError = '';
      } catch(e) {
        $scope.http.jsonError = e.message;
        $scope.http.encodedBytes = null;
        $scope.http.encodedPreview = [];
        $scope.http.encodedHex = '';
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
      $scope.http.loading = true;
      $scope.http.response = null;

      var method = $scope.http.method || 'POST';

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

      var reqInit = {
        method: method,
        headers: Object.assign({
          'Content-Type': $scope.http.contentType || 'application/x-msgpack',
          'Accept': 'application/msgpack, application/x-msgpack, application/json'
        }, customHeaders)
      };

      if (['GET', 'HEAD'].indexOf(method) === -1) {
        if ($scope.http.encodedBytes && $scope.http.payloadJson.trim() !== '') {
          reqInit.body = $scope.http.encodedBytes;
        } else if (($scope.http.payloadJson || '').trim() !== '') {
          // Just in case it's invalid but they submit anyway... wait they can't because of disabled button
          return;
        }
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
            var rawBytes = Array.from(new Uint8Array(data.buffer));
            var decoded;
            var wasMsgpack = false;
            
            if (rawBytes.length === 0) {
              decoded = { _info: 'Empty responses' };
            } else {
              try {
                decoded = msgpack.decode(new Uint8Array(data.buffer));
                wasMsgpack = true;
              } catch(e) {
                // If decode fails, attempt to parse as string/JSON
                try {
                  var str = new TextDecoder().decode(new Uint8Array(data.buffer));
                  decoded = JSON.parse(str);
                } catch(e2) {
                  // Fallback: just raw string
                  decoded = new TextDecoder().decode(new Uint8Array(data.buffer));
                }
              }
            }

            var prettyStr = _renderJson(decoded);

            $scope.http.response = {
              status: data.status,
              ts: new Date(),
              rawBytes: rawBytes,
              wasMsgpack: wasMsgpack,
              decoded: decoded,
              prettyJson: $sce.trustAsHtml(prettyStr)
            };
          });
        })
        .catch(function(err) {
          $scope.$applyAsync(function() {
            $scope.http.loading = false;
            $scope.http.response = {
              status: 'Error',
              ts: new Date(),
              rawBytes: [],
              wasMsgpack: false,
              decoded: err,
              prettyJson: $sce.trustAsHtml(_renderJson(err))
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
