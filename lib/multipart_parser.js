var Buffer = require('buffer').Buffer,
    s = 0,
    // multipartParser 解析阶段, 分为：
    // 1. 开始解析
    // 2. 开始解析边界字符
    // 3. 开始解析字段头部名
    // 4. 开始解析字段头部值
    // 5. 解析字段头部完成
    // 6. 解析字段值（PART_DATA_START）
    // 7. 结束
    S =
    {
        PARSER_UNINITIALIZED: s++,
        START: s++,
        START_BOUNDARY: s++,
        HEADER_FIELD_START: s++,
        HEADER_FIELD: s++,
        HEADER_VALUE_START: s++,
        HEADER_VALUE: s++,
        HEADER_VALUE_ALMOST_DONE: s++,
        HEADERS_ALMOST_DONE: s++,
        PART_DATA_START: s++,
        PART_DATA: s++,
        PART_END: s++,
        END: s++
    },

    f = 1,
    F =
    {
        PART_BOUNDARY: f,
        LAST_BOUNDARY: f *= 2
    },

    // 特殊字符的ASCII值
    LF = 10,  // \r
    CR = 13,  // \n
    SPACE = 32,
    HYPHEN = 45,  // -
    COLON = 58,  // :
    A = 97,
    Z = 122,

    lower = function (c) {
        return c | 0x20;
    };

for (s in S) {
    exports[s] = S[s];
}

// 构造函数
function MultipartParser() {
    this.boundary = null;
    this.boundaryChars = null;
    this.lookbehind = null;
    this.state = S.PARSER_UNINITIALIZED;

    this.index = null;
    this.flags = 0;
}
exports.MultipartParser = MultipartParser;

// 返回 parser 某阶段的字符值
MultipartParser.stateToString = function (stateNumber) {
    for (var state in S) {
        var number = S[state];
        if (number === stateNumber) return state;
    }
};

// 从边界字符开始解析
MultipartParser.prototype.initWithBoundary = function (str) {
    this.boundary = new Buffer(str.length + 4);
    this.boundary.write('\r\n--', 0);
    this.boundary.write(str, 4);
    this.lookbehind = new Buffer(this.boundary.length + 8);
    this.state = S.START;

    // 边界字符中的字符集
    this.boundaryChars = {};
    for (var i = 0; i < this.boundary.length; i++) {
        this.boundaryChars[this.boundary[i]] = true;
    }
};

// 解析数据
MultipartParser.prototype.write = function (buffer) {
    var self = this,
        i = 0,
        len = buffer.length,
        prevIndex = this.index,
        index = this.index,
        state = this.state,
        flags = this.flags,
        lookbehind = this.lookbehind,
        boundary = this.boundary,
        boundaryChars = this.boundaryChars,
        boundaryLength = this.boundary.length,
        boundaryEnd = boundaryLength - 1,
        bufferLength = buffer.length,
        c,
        cl,

        //  为各个阶段的数据标记索引，以此划分数据
        mark = function (name) {
            self[name + 'Mark'] = i;
        },
        // 清楚索引标记
        clear = function (name) {
            delete self[name + 'Mark'];
        },
        // callbackSymbol 具体的实现在 incoming_form 中
        callback = function (name, buffer, start, end) {
            if (start !== undefined && start === end) {
                return;
            }

            var callbackSymbol = 'on' + name.substr(0, 1).toUpperCase() + name.substr(1);
            if (callbackSymbol in self) {
                self[callbackSymbol](buffer, start, end);
            }
        },
        /// 对 callback 的封装，可清除标记
        dataCallback = function (name, clear) {
            var markSymbol = name + 'Mark';
            if (!(markSymbol in self)) {
                return;
            }

            if (!clear) {
                callback(name, buffer, self[markSymbol], buffer.length);
                self[markSymbol] = 0;
            } else {
                callback(name, buffer, self[markSymbol], i);
                delete self[markSymbol];
            }
        };
    // 遍历数据
    for (i = 0; i < len; i++) {
        c = buffer[i];
        switch (state) {
            case S.PARSER_UNINITIALIZED:
                return i;
            case S.START:
                index = 0;
                state = S.START_BOUNDARY;
            case S.START_BOUNDARY:
                if (index == boundary.length - 2) {
                    if (c == HYPHEN) {
                        flags |= F.LAST_BOUNDARY;
                    } else if (c != CR) {
                        return i;
                    }
                    index++;
                    break;
                } else if (index - 1 == boundary.length - 2) {
                    if (flags & F.LAST_BOUNDARY && c == HYPHEN) {
                        callback('end');
                        state = S.END;
                        flags = 0;
                    } else if (!(flags & F.LAST_BOUNDARY) && c == LF) {
                        index = 0;
                        callback('partBegin');
                        state = S.HEADER_FIELD_START;
                    } else {
                        return i;
                    }
                    break;
                }

                if (c != boundary[index + 2]) {
                    index = -2;
                }
                if (c == boundary[index + 2]) {
                    index++;
                }
                break;
            case S.HEADER_FIELD_START:
                state = S.HEADER_FIELD;
                mark('headerField');
                index = 0;
            case S.HEADER_FIELD:
                if (c == CR) {
                    clear('headerField');
                    state = S.HEADERS_ALMOST_DONE;
                    break;
                }

                index++;
                if (c == HYPHEN) {
                    break;
                }

                if (c == COLON) {
                    if (index == 1) {
                        // empty header field
                        return i;
                    }
                    dataCallback('headerField', true);
                    state = S.HEADER_VALUE_START;
                    break;
                }

                cl = lower(c);
                if (cl < A || cl > Z) {
                    return i;
                }
                break;
            case S.HEADER_VALUE_START:
                if (c == SPACE) {
                    break;
                }

                mark('headerValue');
                state = S.HEADER_VALUE;
            case S.HEADER_VALUE:
                if (c == CR) {
                    dataCallback('headerValue', true);
                    callback('headerEnd');
                    state = S.HEADER_VALUE_ALMOST_DONE;
                }
                break;
            case S.HEADER_VALUE_ALMOST_DONE:
                if (c != LF) {
                    return i;
                }
                state = S.HEADER_FIELD_START;
                break;
            case S.HEADERS_ALMOST_DONE:
                if (c != LF) {
                    return i;
                }

                callback('headersEnd');
                state = S.PART_DATA_START;
                break;
            case S.PART_DATA_START:
                state = S.PART_DATA;
                mark('partData');
            case S.PART_DATA:
                prevIndex = index;

                if (index === 0) {
                    // boyer-moore derrived algorithm to safely skip non-boundary data
                    i += boundaryEnd;
                    while (i < bufferLength && !(buffer[i] in boundaryChars)) {
                        i += boundaryLength;
                    }
                    i -= boundaryEnd;
                    c = buffer[i];
                }

                if (index < boundary.length) {
                    if (boundary[index] == c) {
                        if (index === 0) {
                            dataCallback('partData', true);
                        }
                        index++;
                    } else {
                        index = 0;
                    }
                } else if (index == boundary.length) {
                    index++;
                    if (c == CR) {
                        // CR = part boundary
                        flags |= F.PART_BOUNDARY;
                    } else if (c == HYPHEN) {
                        // HYPHEN = end boundary
                        flags |= F.LAST_BOUNDARY;
                    } else {
                        index = 0;
                    }
                } else if (index - 1 == boundary.length) {
                    if (flags & F.PART_BOUNDARY) {
                        index = 0;
                        if (c == LF) {
                            // unset the PART_BOUNDARY flag
                            flags &= ~F.PART_BOUNDARY;
                            callback('partEnd');
                            callback('partBegin');
                            state = S.HEADER_FIELD_START;
                            break;
                        }
                    } else if (flags & F.LAST_BOUNDARY) {
                        if (c == HYPHEN) {
                            callback('partEnd');
                            callback('end');
                            state = S.END;
                            flags = 0;
                        } else {
                            index = 0;
                        }
                    } else {
                        index = 0;
                    }
                }

                if (index > 0) {
                    // when matching a possible boundary, keep a lookbehind reference
                    // in case it turns out to be a false lead
                    lookbehind[index - 1] = c;
                } else if (prevIndex > 0) {
                    // if our boundary turned out to be rubbish, the captured lookbehind
                    // belongs to partData
                    callback('partData', lookbehind, 0, prevIndex);
                    prevIndex = 0;
                    mark('partData');

                    // reconsider the current character even so it interrupted the sequence
                    // it could be the beginning of a new sequence
                    i--;
                }

                break;
            case S.END:
                break;
            default:
                return i;
        }
    }

    // 根据获取到并标记好的数据索引，开始读写表单数据（和文件）
    dataCallback('headerField');
    dataCallback('headerValue');
    dataCallback('partData');

    this.index = index;
    this.state = state;
    this.flags = flags;

    return len;
};

MultipartParser.prototype.end = function () {
    var callback = function (self, name) {
        var callbackSymbol = 'on' + name.substr(0, 1).toUpperCase() + name.substr(1);
        if (callbackSymbol in self) {
            self[callbackSymbol]();
        }
    };
    if ((this.state == S.HEADER_FIELD_START && this.index === 0) ||
        (this.state == S.PART_DATA && this.index == this.boundary.length)) {
        callback(this, 'partEnd');
        callback(this, 'end');
    } else if (this.state != S.END) {
        return new Error('MultipartParser.end(): stream ended unexpectedly: ' + this.explain());
    }
};

MultipartParser.prototype.explain = function () {
    return 'state = ' + MultipartParser.stateToString(this.state);
};
