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



## 📖 Notes  
- Works best over **HTTPS** (for camera/mic access).  
- Mediasoup requires a proper **public IP** for external access.  
- Only one broadcaster per channel can go live at a time.  
