# 🎥 KoHat Live – WebRTC Mediasoup App

This is a simple **two-channel live streaming web app** built with **Node.js, Socket.IO, and Mediasoup**.  
It lets one of two broadcasters go live (camera or screen) and allows multiple viewers to watch in real time.  

---

## 🚀 Features  
- Two broadcaster channels: `b1` and `b2`  
- Live camera or screen sharing  
- Real-time video/audio streaming using WebRTC + Mediasoup  
- Viewer page with quality selector (Auto / High / Medium / Low)  
- Live viewer count  
- Responsive UI (desktop + mobile)  

---

## 📂 Project Structure  
```
my-mediasoup-app/
├── server.js          # Node.js + Express + Mediasoup backend
├── public/
│   ├── index.html     # Home page
│   ├── login.html     # Broadcaster login
│   ├── broadcaster.html # Broadcaster control panel
│   ├── viewer.html    # Viewer page
│   ├── broadcaster.js # Broadcaster-side WebRTC logic
│   ├── viewer.js      # Viewer-side WebRTC logic
│   ├── style.css      # UI styling
```

---

## ⚙️ Installation  

1. **Clone the repo**  
```bash
git clone https://github.com/KoHat1998/my-mediasoup-app.git
cd my-mediasoup-app
```

2. **Install dependencies**  
```bash
npm install
```

3. **Run the server locally**  
```bash
npm start
```
Server runs at: `http://localhost:3000`  

---

## 🌐 Deployment on AWS EC2  
1. Create an EC2 instance (Ubuntu)  
2. Install Node.js and npm  
3. Clone this repo into the server  
4. Open required ports in AWS Security Group:  
   - `3000` (HTTP)  
   - `40000–49999` (UDP/TCP for WebRTC)  
5. Update `ANNOUNCED_IP` in **server.js** with your EC2 public IP  
6. Start the app:  
```bash
node server.js
```
or use **PM2** for production:  
```bash
npm install -g pm2
pm2 start server.js
```

---

## 🔑 Login Credentials  
- **Broadcaster 1** → username: `b1` | password: `changeme1`  
- **Broadcaster 2** → username: `b2` | password: `changeme2`  

*(you can change these in `server.js`)*  

---

## 🖼️ Screenshots  
- **Home Page**  
- **Broadcaster Panel**  
- **Viewer Page with Quality Selector**  

*(add screenshots here later if needed)*  

---

## 📖 Notes  
- Works best over **HTTPS** (for camera/mic access).  
- Mediasoup requires a proper **public IP** for external access.  
- Only one broadcaster per channel can go live at a time.  
