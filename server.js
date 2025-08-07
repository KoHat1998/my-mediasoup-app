const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);

const mediasoup = require('mediasoup'); // Add mediasoup

app.get('/', (req, res) => {
    res.send('Hello mediasoup!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('Server running on port', PORT);
});
