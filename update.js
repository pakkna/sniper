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
    const output = execSync("git pull origin main", { 
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

console.log("------- [ RESTARTING ENGINE ] -------");
try {
    console.log("🚀 Server Restart successfully!");
    // Restarting all PM2 processes to ensure everything is fresh
    execSync("pm2 restart all", { stdio: "ignore" });
} catch (error) {
    console.error("❌ PM2 Restart failed. Check your process manager.");
}
