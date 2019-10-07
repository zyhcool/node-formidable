const http = require("http");
const fs = require("fs");
const path = require("path");
const formidable = require('../simple-version');

const name = "data.txt";
const resultPath = path.resolve(__dirname, name);

let server = http.createServer((req, res) => {
    if (req.url == '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
            '<form action="/upload" enctype="multipart/form-data" method="post">' +
            '<input type="text" name="title"><br>' +
            '<input type="file" name="upload" multiple="multiple"><br>' +
            '<input type="submit" value="Upload">' +
            '</form>'
        );
    } else if (req.url == '/upload') {
        let formy = new formidable.IncomingForm();
        formy
            .on('field', function (field, value) {
                console.log(field, value);
            })
            .on('file', function (field, file) {
                console.log(field, file);
            })
            .on("end", function () {
                res.writeHead(200, { "content-type": "application/json" })
                res.end(JSON.stringify({
                    code: 0,
                    data: "good",
                }))
            })
        formy.parse(req);
    }
});

if (fs.existsSync(resultPath)) {
    fs.unlinkSync(resultPath);
}
server.listen(3000)
console.log("listening on 3000...");

// let arr = '------WebKitFormBoundarywA1wAy4KrejGYQgv'.split("").map((s)=>{
//     let t=  s.codePointAt();
//     return t.toString(16)
// })
// console.log(arr)