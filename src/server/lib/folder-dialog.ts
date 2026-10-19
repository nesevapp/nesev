// Native "choose folder" dialog for the first-start setup (the browser can't hand out real paths). Runs on the
// machine nesev runs on, which is the user's own (loopback only). null = cancelled or not available.

type Cmd = string[];

function dialogCommand(prompt: string, platform = process.platform): Cmd | null {
  if (platform === "darwin") return ["osascript", "-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`];
  if (platform === "win32")
    return [
      "powershell.exe",
      "-NoProfile",
      "-STA",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
        `$d.Description = '${prompt.replaceAll("'", "''")}'; $d.ShowNewFolderButton = $true; ` +
        "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
    ];
  if (Bun.which("zenity")) return ["zenity", "--file-selection", "--directory", `--title=${prompt}`];
  if (Bun.which("kdialog")) return ["kdialog", "--getexistingdirectory", ".", "--title", prompt];
  return null;
}

export function canPickFolder(platform = process.platform): boolean {
  return dialogCommand("", platform) !== null;
}

export async function pickFolder(prompt: string): Promise<string | null> {
  const cmd = dialogCommand(prompt);
  if (!cmd) return null;
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const path = out.trim().replace(/[\\/]$/, "");
  return code === 0 && path ? path : null;
}

/** Opens `dir` in Finder / Explorer / the desktop's file manager. */
export function revealFolder(dir: string): boolean {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  if (process.platform !== "win32" && !Bun.which(opener)) return false;
  Bun.spawn([opener, dir], { stdout: "ignore", stderr: "ignore" });
  return true;
}
