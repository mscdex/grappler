Grappler
========

Grappler is a minimalistic server for "comet" connections that exposes a single, consistent API across all transports.
Grappler currently supports the following transports (each with a list of currently known supported browsers):

* WebSockets (with Flash policy support -- watches for policy requests on the same port as the grappler server)
  * Firefox 4, Chrome 4+, Safari 5, or any browser that supports at least Flash 9.x
* XHR Multipart Streaming
  * Firefox 3+, Safari 5 (maybe 4.0 also?), Chrome 1+
* Server-Sent Events
  * Chrome 6+, Safari 5, Opera 9.x-10.x (DOM only)
* XHR Long Polling
  * Any browser that supports XMLHttpRequest*

\* - Some browsers' XMLHttpRequest implementations contain unexpected quirks (e.g. the built-in web browser for Android 1.6)

Requirements
============

* Node.JS (tested with v0.4.2 -- may work with older versions)
* A client supporting one of the aforementioned transports.
* For HTTP (non-WebSocket) clients, cookies must be enabled for clients ONLY if they are going to send messages (i.e. via POST) to the server.

Example (broadcast echo)
========================

1. Run examples/echo/server.js.
2. Visit the demo server's page in one or more browsers: http://127.0.0.1:8080/demo.htm

API
===

Grappler exports one main object: `Server`.

lib/common.js exports `LOG` and `STATE` objects, which contain constants used for
when logging messages and checking the state of a client respectively.

The `LOG` object is:

    {
      INFO: 1,
      WARN: 2,
      ERROR: 3
    }

The `STATE` object is:

    {
      ACCEPTED: 1, // internal use only
      TEMP: 2, // internal use only
      PROTO_HTTP: 4, // client is HTTP-based
      PROTO_WEBSOCKET: 8 // client is WebSocket-based
    }

## Server

### Constructor: new Server([options], [fnHandleNormalHTTP], [fnAcceptClient])

Creates a new instance of a grappler server.

`options` is an object with the following default values:

    {
      // A callback for receiving "debug" information. It is called with two arguments: message and message level.
      // Message level is one of the values in the `LOG` object.
      logger: function(msg, msgLevel) {},

      // A string or array of strings which denote who is allowed to connect to this grappler Server instance.
      // The format of the string is: "hostname:port", "hostname", or an asterisk substituted for either the hostname
      // or port, or both, to act as a wildcard.
      origins: "*:*",
      
      // An integer value in milliseconds representing the interval in which a ping is sent to an HTTP client for those
      // transports that need to do so.
      pingInterval: 3000,

      // A storage provider used to store client objects. The default is to use 'object', a simple hash. Other available
      // storage providers can be found in lib/storage. The value here is the name without the 'storage' prefix and file extension.
      storage: 'object'
    }

`fnHandleNormalHTTP` is a callback which is able to override grappler for an incoming HTTP connection.
If no headers are sent, then grappler takes control of the connection. The arguments provided to this callback are the
same for `http.Server`'s `request` event, that is: http.ServerRequest and http.ServerResponse objects. It should be
noted that if you want grappler to automatically handle all incoming HTTP connections but want to specify a callback
for `fnAcceptClient`, you need to specify a `false` value for `fnHandleNormalHTTP`.

`fnAcceptClient` is a callback that is executed the moment a client connects. The main purpose of this callback is to
have the chance to immediately deny a client further access to the grappler server. For example, your application may
maintain a blacklist or may automatically blacklist/throttle back a certain IP after x connections in a certain amount of time.
If this callback returns `false`, the connection will automatically be dropped, otherwise the connection will be permitted.
The callback receives one argument, which is the `net.Stream` object representing the connection.

### Event: connection

`function(client) { }`

This event is emitted every time a new client has successfully connected to the system.
`client` is an instance of `HttpClient`.

### Event: error

`function(err) { }`

Emitted when an unexpected error occurs.

### listen(port, [host])

Starts the server listening on the specified `port` and `host`. If `host` is omitted, the server will listen on any IP address.

### broadcast(data[, encoding])

Sends `data` to every connected client using an optional `encoding`.

### shutdown()

Shuts down the server by no longer listening for incoming connections and severing any existing client connections.


## HttpClient

There is one other important object that is used in grappler, and that is the `HttpClient` object.
`HttpClient` represents a user connected to the server and can be used to interact with that user.

### Event: drain

`function() { }`

Emitted when the client's write buffer becomes empty.

### Event: close

`function() { }`

Emitted when the client has disconnected.

### state

A bit field containing the current state of the client. See the previously mentioned `STATE` object for valid bits.

### remoteAddress

The IP address of the client.

### write(data[, encoding])

Sends `data` using an optional `encoding` to the client.
This function returns `true` if the entire data was flushed successfully to the kernel
buffer. Otherwise, it will return `false` if all or part of the data was queued in user memory.
`drain` will be emitted when the kernel buffer is free again.

### broadcast(data[, encoding])

Sends `data` to all other connected clients using an optional `encoding`.

### disconnect()

Forcefully severs the client's connection to the server.