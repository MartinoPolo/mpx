param(
    [uint32]$FlashCount = 3
)

# --- Mute controls (skip sound AND flash entirely) ---
$AgentDirectory = if ($env:PI_CODING_AGENT_DIR) {
    $env:PI_CODING_AGENT_DIR
} else {
    Join-Path $env:USERPROFILE '.pi\agent'
}
$MuteFlag = Join-Path $AgentDirectory 'notify-mute'
if ($env:PI_NOTIFY_SILENT -eq '1' -or (Test-Path $MuteFlag)) { exit 0 }

# FlashWindowEx + sound notification for Pi.
# Flashes the parent terminal/editor window's taskbar icon orange and plays a sound.
# Works in Windows Terminal, VS Code, standalone PowerShell/cmd.
# Always notifies (sound + flash) regardless of window focus.
# Uses NtQueryInformationProcess for fast parent PID walk (no WMI).

# Use the Windows asset directly; account migration must not change the sound.
$SoundFile = Join-Path $env:WINDIR 'Media\tada.wav'
if (-not (Test-Path -LiteralPath $SoundFile -PathType Leaf)) {
    Write-Error "Windows notification sound not found: $SoundFile"
    exit 1
}

# --- Win32 P/Invoke for taskbar flash ---

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;

public struct FLASHWINFO {
    public uint cbSize;
    public IntPtr hwnd;
    public uint dwFlags;
    public uint uCount;
    public uint dwTimeout;
}

[StructLayout(LayoutKind.Sequential)]
public struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
}

public static class NativeFlash {
    [DllImport("user32.dll")]
    public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle, int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation,
        int processInformationLength, out int returnLength);

    public static void Flash(IntPtr hwnd, uint count) {
        FLASHWINFO fw = new FLASHWINFO();
        fw.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
        fw.hwnd = hwnd;
        fw.dwFlags = 3; // FLASHW_ALL (caption + taskbar)
        fw.uCount = count;
        fw.dwTimeout = 0;
        FlashWindowEx(ref fw);
    }

    public static int GetParentProcessId(int pid) {
        try {
            using (Process proc = Process.GetProcessById(pid)) {
                PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
                int returnLength;
                int status = NtQueryInformationProcess(
                    proc.Handle, 0, ref pbi,
                    Marshal.SizeOf(pbi), out returnLength);
                if (status != 0) return 0;
                return pbi.InheritedFromUniqueProcessId.ToInt32();
            }
        } catch {
            return 0;
        }
    }
}
"@ -ErrorAction SilentlyContinue

# --- Find ancestor window ---

$hwnd = [IntPtr]::Zero
$id = $PID

for ($i = 0; $i -lt 20; $i++) {
    try {
        $proc = [System.Diagnostics.Process]::GetProcessById($id)
        $h = $proc.MainWindowHandle
        if ($h -ne [IntPtr]::Zero -and [NativeFlash]::IsWindowVisible($h)) {
            $hwnd = $h
            break
        }
        $parentId = [NativeFlash]::GetParentProcessId($id)
        if ($parentId -eq 0 -or $parentId -eq $id) { break }
        $id = $parentId
    } catch { break }
}

# --- Play sound ---

try {
    $player = New-Object System.Media.SoundPlayer $SoundFile
    $player.Load()
    $player.PlaySync()
} catch {
    Write-Error "Unable to play Windows tada: $_"
    exit 1
} finally {
    if ($player) { $player.Dispose() }
}

# --- Flash taskbar ---

if ($hwnd -ne [IntPtr]::Zero) {
    [NativeFlash]::Flash($hwnd, $FlashCount)
}
