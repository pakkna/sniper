import { execSync } from "child_process";
import pathModule from "path";

// Specified path for update
const path = "/root/sniper";

console.log("------- [ SYSTEM UPDATE START ]  -------");

try {
    const absolutePath = pathModule.isAbsolute(path) ? path : pathModule.resolve(path);
    //console.log(`> Updating Path: ${absolutePath}`);
    const output = execSync("git pull origin main", { 
        cwd: absolutePath, 
        encoding: "utf8",
        stdio: "pipe" 
    });
    
    console.log(`✅ Result: ${output.trim()}`);
} catch (error) {
    console.error(`❌ Update Error at : ${error.message}`);
    if (error.stdout) console.log(`Output: ${error.stdout}`);
    if (error.stderr) console.error(`Stderr: ${error.stderr}`);
}

console.log("------- [ RESTARTING ENGINE ] -------");
try {
    // Restarting all PM2 processes to ensure everything is fresh
    execSync("pm2 restart all", { stdio: "inherit" });
    console.log("🚀 Server Restart successfully!");
} catch (error) {
    console.error("❌ PM2 Restart failed. Check your process manager.");
}
