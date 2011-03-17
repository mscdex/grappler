if (!String.prototype.trim) {
	String.prototype.trim = function() {
		var	str = this.replace(/^\s\s*/, ''),
			ws = /\s/,
			i = str.length;
		while (ws.test(str.charAt(--i)));
		return str.slice(0, i + 1);
	}
}

function initTransport(cbConnect, cbData, cbDisconnect, cbError) {
	var transport = {
		connect: null,
		send: null,
		disconnect: null,
		_instance: null,
		_host: null
	};
	cbConnect = cbConnect || empty;
	cbData = cbData || empty;
	cbDisconnect = cbDisconnect || empty;
	cbError = cbError || empty;

	WEB_SOCKET_SWF_LOCATION = "WebSocketMain.swf";
	WEB_SOCKET_DEBUG = false;

	function getXHR() {
		var xhr = null;
		try {
			xhr = new XMLHttpRequest();
		} catch(e) {}
		if (!xhr) {
			try {
				xhr = new ActiveXObject('Msxml2.XMLHTTP.6.0');
			} catch(e) {}
		}
		if (!xhr) {
			try {
				xhr = new ActiveXObject('Msxml2.XMLHTTP.3.0');
			} catch(e) {}
		}
		if (!xhr) {
			try {
				xhr = new ActiveXObject('Msxml2.XMLHTTP');
			} catch(e) {}
		}
		return xhr;
	};

	function xhrSendData(host, data, method, callback) {
		var xhr = getXHR();
		if (typeof method === 'function') {
			callback = method;
			method = undefined;
		}
		callback = callback || empty;

		xhr.open(method || 'POST', 'http://' + host);
		/*xhr.onreadystatechange = function() {
			if (xhr.readyStatus == 4) {
				if (xhr.status == 0)
					callback('Error while sending data: Unable to connect');
				else if (xhr.status == 200)
					callback();
				else
					callback('Error while sending data: Unexpected HTTP status code: ' + xhr.status);
			}
		};*/
		if (data)
			xhr.send(data);
		else
			xhr.send();

		if (xhr.status == 0)
			return 'Error while sending data: Unable to connect';
		else if (xhr.status == 200)
			return true;
		else
			return 'Error while sending data: Unexpected HTTP status code: ' + xhr.status;
	}

	if (window.WebSocket) {
		transport.connect = function(host) {
			transport._host = host;
			transport._instance = new WebSocket("ws://" + host);
			transport._instance.onmessage = function(ev) { cbData(ev.data); };
			transport._instance.onclose = function() { cbDisconnect(); };
			transport._instance.onopen = function() { cbConnect(); };
			transport._instance.onerror = function() { if (transport._instance.readyState == 3) cbError('Unable to connect'); };
		}
		transport.disconnect = function() {
			try {
				transport._instance.close();
				return true;
			} catch (e) {
				return false;
			}
		}
		transport.send = function(data) {
			try {
				return (data.length > 0 ? transport._instance.send(data) : 'Nothing to send')
			} catch (e) {
				return ''+e;
			}
		}
	} else if (typeof getXHR().multipart !== 'undefined') {
		transport.connect = function(host) {
			transport._host = host;
			var fnTimeout = function() { if (!transport._instance.dcManual) transport.disconnect(); };
			var timeoutVal = 4000;
			transport._instance = (transport._instance ? transport._instance : getXHR());
			transport._instance.multipart = true;
			transport._instance.open('GET', 'http://' + host + '/?' + (new Date()).getTime(), true);
			transport._instance.isFirst = true;
			transport._instance.dcManual = false;
			transport._instance.setRequestHeader('Accept', 'multipart/x-mixed-replace');
			transport._instance.onreadystatechange = function() {
				if (transport._instance.isFirst) {
					transport._instance.isFirst = false;
					cbConnect();
				}
				if (transport._instance.readyState == 3)
					cbData(transport._instance.responseText);
				else if (transport._instance.readyState == 4)
					if (transport._instance.status == 0)
						cbError('Unable to connect');
					else {
						if (transport._instance.dcTimeout)
							clearTimeout(transport._instance.dcTimeout);
						transport._instance.dcTimeout = setTimeout(fnTimeout, timeoutVal);
					}
			};
			transport._instance.send();
		}
		transport.disconnect = function() {
			try {
				transport._instance.dcManual = true;
				transport._instance.abort();
				cbDisconnect();
				return true;
			} catch (e) {
				return false;
			}
		}
		transport.send = function(data) {
			try {
				return (data.length > 0 ? xhrSendData(transport._host, data) : 'Nothing to send');
			} catch (e) {
				return 'Unable to connect';
			}
		}
	} else if (window.EventSource) {
		transport.connect = function(host) {
			transport._host = host;
			transport._instance.dcManual = false;
			transport._instance = new EventSource('http://' + host + '/?' + (new Date()).getTime());
			transport._instance.onmessage = function(ev) { cbData(ev.data); };
			transport._instance.onopen = function(ev) {	cbConnect(); };
			transport._instance.onerror = function(ev) {
				if (transport._instance.readyState != 2 && transport._instance.dcManual)
					cbDisconnect();
				else if (transport._instance.readyState == 2 && !transport._instance.dcManual)
					cbError('Unable to connect');
			};
		}
		transport.disconnect = function() {
			try {
				transport._instance.dcManual = true;
				transport._instance.close();
				// It seems onerror() isn't fired when using .close()?
				return true;
			} catch (e) {
				return false;
			}
		}
		transport.send = function(data) {
			try {
				return (data.length > 0 ? xhrSendData(transport._host, data) : 'Nothing to send');
			} catch (e) {
				return 'Unable to connect';
			}
		}
	} else if (getXHR()) {
		transport.connect = function(host) {
			if (arguments.length == 1) {
				transport._host = host;
				transport._instance = getXHR();
				transport._instance.dcManual = false;
				transport._instance.onreadystatechange = function() {
					if (transport._instance.readyState == 4) {
						if (transport._instance.status == 200) {
							if (transport._instance.responseText.length)
								cbData(transport._instance.responseText);
							if (!transport._instance.dcManual)
								setTimeout(function() { transport.connect(); }, 1);
						} else if (transport._instance.status == 0) {
							cbDisconnect();
							transport.disconnect();
						}
					}
				};
			}
			transport._instance.open('GET', 'http://' + transport._host + '/?' + (new Date()).getTime(), true);
			transport._instance.send();
			if (arguments.length == 1)
				cbConnect();
		}
		transport.disconnect = function() {
			try {
				transport._instance.dcManual = true;
				transport._instance.abort();
				return true;
			} catch (e) {
				return false;
			}
		}
		transport.send = function(data) {
			try {
				return (data.length > 0 ? xhrSendData(transport._host, data) : 'Nothing to send');
			} catch (e) {
				return 'Unable to connect';
			}
		}
	}

	return transport;
}