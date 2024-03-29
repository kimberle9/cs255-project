var lib = require('./lib');
var sjcl = require('./sjcl');

var fs = require('fs');
var tls = require('tls');

var hex_to_bitarray = lib.hex_to_bitarray;
var bitarray_to_hex = lib.bitarray_to_hex;
var ECDSA_sign = lib.ECDSA_sign;

var client = function(client_sec_key_base64,
                      client_sec_key_password,
                      ca_cert, suid) {
  var client_log = lib.log_with_prefix('client');
  var PROTOCOL_MESSAGE_TYPE = lib.PROTOCOL_MESSAGE_TYPE,
      PROTOCOL_STATE = lib.PROTOCOL_STATE,
      SESSION_EVENT = lib.SESSION_EVENT;

  var socket;
  var protocol_state;

  var curve = sjcl.ecc.curves['c256'];

  var client_sec_key = lib.ECDSA_load_sec_key(client_sec_key_base64, client_sec_key_password);

  var session_callback = null;

  function protocol_abort(client) {
    if (protocol_state == PROTOCOL_STATE.ABORT) {
      return;
    }

    client_log('protocol aborted');
    socket.destroy();
    protocol_state = PROTOCOL_STATE.ABORT;
  }

  function check_cert(crt) {
    console.log(crt);
    //check that server's certificate has valid fields
    if (crt.valid_from ==null || crt.valid_to ==null || crt.issuer ==null || crt.subject ==null || crt.fingerprint ==null){
      protocol_abort();
      return false;
    } 
    
    
    var subject_fields = {
      C: 'US',
      ST: 'CA',
      L: 'Stanford',
      O: 'CS 255',
      OU: 'Project 2',
      CN: 'ec2-54-67-122-91.us-west-1.compute.amazonaws.com',
      emailAddress: 'cs255ta@cs.stanford.edu',
    }
    
    //check that current date is within server's certificate validity window, and does not expire within 120 days
    var date_now = new Date();
    var date_120 = date_now;
    var date_from = new Date(crt.valid_from);
    var date_to = new Date(crt.valid_to);
    date_120.setDate(date_now.getDate() + 120);
    if (date_now < date_from || date_120 > date_to) {
      console.log("Invalid certificate date range");
      protocol_abort();
      return false;
    }
    
    for(field in subject_fields)
    {
      if(subject_fields[field] != crt.subject[field])
      {
        console.log("No can do, expected: "+ subject_fields[field] + " found: "+ crt.subject[field]);
        protocol_abort();
        return false;
      }
    }

    return true; 
  }

  function compute_response(challenge) {
    //step1: convert challenge to bit_array
    var challenge_bitarray = hex_to_bitarray(challenge);
    //step2: compute signature for the challenge
    var computed_sig = ECDSA_sign(client_sec_key, challenge_bitarray);
    //step 3:convert the signature to hex, and return it
    return bitarray_to_hex(computed_sig);
  }

  // Note: You will not need to modify this function
  function process_server_msg(client, json_data) {
    // If protocol has been aborted, then ignore subsequent messages
    if (protocol_state == PROTOCOL_STATE.ABORT) {
      return;
    }

    var data;
    try {
      data = JSON.parse(json_data);
    } catch (ex) {
      console.trace(ex);
      protocol_abort(client);
      return;
    }

    switch (data.type) {
    case PROTOCOL_MESSAGE_TYPE.CHALLENGE:
      if (protocol_state != PROTOCOL_STATE.START) {
        client_log('received challenge in bad state: ' +
                   lib.reverse_lookup(PROTOCOL_STATE, protocol_state));
        protocol_abort(client);
        return;
      }
      client_log('received challenge: ' + data.message);
      protocol_state = PROTOCOL_STATE.CHALLENGE;

      var response = compute_response(data.message);

      lib.send_message(socket, PROTOCOL_MESSAGE_TYPE.RESPONSE, response, suid);
      client_log('sent response: ' + response);
      break;

    case PROTOCOL_MESSAGE_TYPE.SESSION_MESSAGE:
      if (protocol_state != PROTOCOL_STATE.SESSION) {
        client_log('received session message in bad state: ' +
                   lib.reverse_lookup(PROTOCOL_STATE, protocol_state));
        protocol_abort(client);
        return;
      }
      client_log('received session message: ' + data.message);
      break;

    case PROTOCOL_MESSAGE_TYPE.SUCCESS:
      if (protocol_state != PROTOCOL_STATE.CHALLENGE) {
        client_log('received success message in bad state: ' +
                   lib.reverse_lookup(PROTOCOL_STATE, protocol_state));
        protocol_abort(client);
        return;
      }
      protocol_state = PROTOCOL_STATE.SESSION;
      client_log('session established');
      client_log('your secret session message is ' + data.message);

      protocol_abort(client);

      break;

    case PROTOCOL_MESSAGE_TYPE.END:
      if (protocol_state != PROTOCOL_STATE.SESSION) {
        client_log('received end message in bad state: ' +
                   lib.reverse_lookup(PROTOCOL_STATE, protocol_state));
        protocol_abort(client);
        return;
      }
      socket.removeListener('data', socket_data_handler);
      socket.end();
      protocol_state = PROTOCOL_STATE.END;
      client_log('session ended');
      break;

    default:
      client_log('received message of unknown type: ' + data.type);
      protocol_abort(client);
      return;
    }
  }

  var client = {};

  client.connect = function(host, port) {
    // filling in the ca, the host and the port
    var client_options = {
      ca: ca_cert,
      host: host,
      port: port,
      rejectUnauthorized: true
    };

    for (var k in client_options) {
      if (!client_options.hasOwnProperty(k) || client_options[k] === null) {
        throw 'Error: client_options not fully initialized';
      }
    }
    
    protocol_state = PROTOCOL_STATE.START;

    var st = {};
    var post_connect = (function (st) {
      return function() {
        var socket = st.socket, client = st.client;
        client_log('connected to server');

        if (!check_cert(socket.getPeerCertificate())) {
          client_log('bad certificate received');
          protocol_abort(client);
        }

        socket.setEncoding('utf8');

        socket_data_handler = (function(client) {
          return function(msg) {
            process_server_msg(client, msg);
          };
        })(client);

        socket.on('data', socket_data_handler);
        socket.on('end', function() {
          if (protocol_state !== PROTOCOL_STATE.END &&
              protocol_state !== PROTOCOL_STATE.ABORT) {
            protocol_abort(client);
          }
        });
      };
    })(st);

    socket = tls.connect(port, client_options, post_connect);
    socket.on('error', function(ex) {
      client_log('TLS handshake failed when trying to connect to server');
      client_log(ex);
    });

    st.socket = socket;
    st.client = client;
  };

  return client;
};

module.exports.client = client;
