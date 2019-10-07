if (global.GENTLY) require = GENTLY.hijack(require);

var crypto = require('crypto');
var util = require('util'),
    path = require('path'),
    File = require('./file'),
    MultipartParser = require('./multipart_parser').MultipartParser,
    StringDecoder = require('string_decoder').StringDecoder,
    EventEmitter = require('events').EventEmitter,
    Stream = require('stream').Stream,
    os = require('os');


// 构造函数，继承自 EventEmitter
function IncomingForm() {
    if (!(this instanceof IncomingForm)) return new IncomingForm();
    EventEmitter.call(this);

    this.encoding = 'utf-8';

    this.headers = null;

    // multipart_parser 的实例
    this._parser = null;

    return this;
}
util.inherits(IncomingForm, EventEmitter);
exports.IncomingForm = IncomingForm;

// req：IncomingMessage ，解析请求的数据
IncomingForm.prototype.parse = function (req) {
    // 暂停数据的传输
    this.pause = function () {
        req.pause();
    };

    // 重新接收数据
    this.resume = function () {
        req.resume();
    };

    // Parse headers and setup the parser, ready to start listening for data.
    // 解析请求头部信息，初始化 mutilpart_parser
    this.writeHeaders(req.headers);

    // Start listening for data.
    var self = this;
    req
        .on('data', function (buffer) {
            // 监听 data 事件，获取前端分包数据
            self.write(buffer);
        })
        .on('end', function () {
            self._parser.end();
        });
    return this;
};

IncomingForm.prototype.writeHeaders = function (headers) {
    this.headers = headers;
    this._parseContentType();
};

IncomingForm.prototype.write = function (buffer) {
    // 使用 parser 解析数据
    var bytesParsed = this._parser.write(buffer);
    return bytesParsed;
};

IncomingForm.prototype.pause = function () {
    // this does nothing, unless overwritten in IncomingForm.parse
    return false;
};

IncomingForm.prototype.resume = function () {
    // this does nothing, unless overwritten in IncomingForm.parse
    return false;
};

// 为 part 绑定 data 和 end 事件处理函数
// 如果是文件数据（filename有值），则使用 File 对象来读写文件数据
// 如果是普通表单数据，则直接获取字符
IncomingForm.prototype.handlePart = function (part) {
    var self = this;
    // This MUST check exactly for undefined. You can not change it to !part.filename.
    if (part.filename === undefined) {
        var value = '',
            decoder = new StringDecoder(this.encoding);

        part.on('data', function (buffer) {
            value += decoder.write(buffer);
        });

        // 解析完成，发起 field 事件，将表单字段名和字段值传给事件回调函数
        part.on('end', function () {
            self.emit('field', part.name, value);
        });
        return;
    }

    var file = new File({
        path: this._uploadPath(part.filename),
        name: part.filename,
        type: part.mime,
    });

    this.emit('fileBegin', part.name, file);

    file.open();

    part.on('data', function (buffer) {
        // 写入文件时暂停数据接收，完成后继续
        self.pause();
        file.write(buffer, function () {
            self.resume();
        });
    });

    // 解析完成，发起 file 事件，将表单字段名和文件对象传给事件回调函数
    part.on('end', function () {
        file.end(function () {
            self.emit('file', part.name, file);
            self._maybeEnd();
        });
    });
};



// 获取请求数据的数据类型
IncomingForm.prototype._parseContentType = function () {
    // 重点：前端的 formdata 携带文件的数据格式；使用正则表达式匹配出边界字符串
    if (this.headers['content-type'].match(/multipart/i)) {
        var m = this.headers['content-type'].match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (m) {
            this._initMultipart(m[1] || m[2]);
        }
        return;
    }
};

IncomingForm.prototype._initMultipart = function (boundary) {
    // 初始化 parser
    var parser = new MultipartParser(),
        self = this,
        headerField,
        headerValue,
        part;
    // 边界字符
    parser.initWithBoundary(boundary);

    // 解析字段值
    // part 为 Stream 实例，Stream 是 EventEmitter 的实例，内部已经实现了事件 data 和 end
    parser.onPartBegin = function () {
        part = new Stream();
        part.readable = true;
        part.headers = {};
        part.name = null;
        part.filename = null;
        part.mime = null;

        part.transferEncoding = 'binary';
        part.transferBuffer = '';

        headerField = '';
        headerValue = '';
    };

    parser.onHeaderField = function (b, start, end) {
        headerField += b.toString(self.encoding, start, end);
    };

    parser.onHeaderValue = function (b, start, end) {
        headerValue += b.toString(self.encoding, start, end);
    };

    parser.onHeaderEnd = function () {
        headerField = headerField.toLowerCase();
        part.headers[headerField] = headerValue;

        // matches either a quoted-string or a token (RFC 2616 section 19.5.1)
        var m = headerValue.match(/\bname=("([^"]*)"|([^\(\)<>@,;:\\"\/\[\]\?=\{\}\s\t/]+))/i);
        if (headerField == 'content-disposition') {
            if (m) {
                part.name = m[2] || m[3] || '';
            }

            part.filename = self._fileName(headerValue);
        } else if (headerField == 'content-type') {
            part.mime = headerValue;
        } else if (headerField == 'content-transfer-encoding') {
            part.transferEncoding = headerValue.toLowerCase();
        }

        headerField = '';
        headerValue = '';
    };

    parser.onHeadersEnd = function () {
        switch (part.transferEncoding) {
            case 'binary':
            case '7bit':
            case '8bit':
                parser.onPartData = function (b, start, end) {
                    part.emit('data', b.slice(start, end));
                };

                parser.onPartEnd = function () {
                    part.emit('end');
                };
                break;

            case 'base64':
                parser.onPartData = function (b, start, end) {
                    part.transferBuffer += b.slice(start, end).toString('ascii');

                    /*
                    four bytes (chars) in base64 converts to three bytes in binary
                    encoding. So we should always work with a number of bytes that
                    can be divided by 4, it will result in a number of buytes that
                    can be divided vy 3.
                    */
                    var offset = parseInt(part.transferBuffer.length / 4, 10) * 4;
                    part.emit('data', new Buffer(part.transferBuffer.substring(0, offset), 'base64'));
                    part.transferBuffer = part.transferBuffer.substring(offset);
                };

                parser.onPartEnd = function () {
                    part.emit('data', new Buffer(part.transferBuffer, 'base64'));
                    part.emit('end');
                };
                break;

            default:
                return;
        }

        self.handlePart(part);
    };

    parser.onEnd = function () {
        self.ended = true;
        self._maybeEnd();
    };

    this._parser = parser;
};

IncomingForm.prototype._fileName = function (headerValue) {
    // matches either a quoted-string or a token (RFC 2616 section 19.5.1)
    var m = headerValue.match(/\bfilename=("(.*?)"|([^\(\)<>@,;:\\"\/\[\]\?=\{\}\s\t/]+))($|;\s)/i);
    if (!m) return;

    var match = m[2] || m[3] || '';
    var filename = match.substr(match.lastIndexOf('\\') + 1);
    filename = filename.replace(/%22/g, '"');
    filename = filename.replace(/&#([\d]{4});/g, function (m, code) {
        return String.fromCharCode(code);
    });
    return filename;
};

IncomingForm.prototype._uploadPath = function (filename) {
    var buf = crypto.randomBytes(16);
    var name = 'upload_' + buf.toString('hex');
    return path.join(os.tmpdir(), name);
};

IncomingForm.prototype._maybeEnd = function () {
    if (!this.ended || this._flushing || this.error) {
        return;
    }

    this.emit('end');
};