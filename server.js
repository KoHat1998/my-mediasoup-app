const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); // if you want to serve static files

const PORT = process.env.PORT || 3000;
let worker;
let router;

async function startMediasoup() {
    worker = await mediasoup.createWorker();
    router = await worker.createRouter({
        mediaCodecs: [
            {
                kind: "audio",
                mimeType: "audio/opus",
                clockRate: 48000,
                channels: 2
            },
            {
                kind: "video",
                mimeType: "video/VP8",
                clockRate: 90000,
                parameters: {}
            }
        ]
    });
    console.log('Mediasoup worker and router started.');
}

startMediasoup();

app.get('/', (req, res) => {
    res.send('Hello mediasoup!');
});

server.listen(PORT, () => {
    console.log('Server running on port', PORT);
});
