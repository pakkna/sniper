import { execSync } from "child_process";
import pathModule from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathModule.dirname(__filename);

// Specified path for update dynamically resolves to the project's folder
const path = __dirname;

console.log("------- [ SYSTEM UPDATE START ]  -------");

try {
    const absolutePath = pathModule.isAbsolute(path) ? path : pathModule.resolve(path);
    const output = execSync("git pull origin multi", { 
        cwd: absolutePath, 
        encoding: "utf8",
        stdio: "pipe" 
    });
    
    if (output.includes("Already up to date")) {
        console.log("✅ Result: Already up to date.");
    } else {
        console.log("✅ Result: New system updated Successfully");
    }
} catch (error) {
    console.log("❌ Result: Failed to update the system");
}

// console.log("------- [ ADD HOST IP ] -------");
// try {
//     // Adding Host IP to /etc/hosts
//     execSync(`sudo sed -i '/api\\.ivacbd\\.com/d' /etc/hosts && echo "13.232.227.28 api.ivacbd.com" | sudo tee -a /etc/hosts > /dev/null`, { stdio: "ignore" });

//     //execSync("sudo sed -i '/api\.ivacbd\.com/d' /etc/hosts", { stdio: "ignore" });
//     execSync("sudo systemctl restart systemd-resolved", { stdio: "ignore" });

//     console.log("✅ Host IP added successfully!");
// } catch (error) {
//     console.error("❌ Failed to add Host IP. Error:", error.message);
// }
 

console.log("------- [ RESTARTING ENGINE ] -------");
try {
    console.log("🚀 Server Restart successfully!");
    // Restarting all PM2 processes to ensure everything is fresh
    execSync("pm2 restart all", { stdio: "ignore" });
} catch (error) {
    console.error("❌ PM2 Restart failed. Check your process manager.");
}
