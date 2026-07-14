using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MinimalWaveBassHelper;

internal static class SpotifyProcessFinder
{
    private const uint ProcessSnapshot = 0x2;

    public static Process? FindRoot()
    {
        Process[] processes = Process.GetProcessesByName("Spotify");
        if (processes.Length == 0)
        {
            return null;
        }

        try
        {
            HashSet<int> spotifyIds = processes.Select(process => process.Id).ToHashSet();
            Dictionary<int, int> parents = ReadParentProcesses();
            Process selected = processes
                .Where(process => !parents.TryGetValue(process.Id, out int parentId) || !spotifyIds.Contains(parentId))
                .OrderBy(SafeStartTime)
                .FirstOrDefault() ?? processes.OrderBy(SafeStartTime).First();

            foreach (Process process in processes)
            {
                if (process.Id != selected.Id)
                {
                    process.Dispose();
                }
            }

            return selected;
        }
        catch
        {
            foreach (Process process in processes)
            {
                process.Dispose();
            }
            return null;
        }
    }

    private static DateTime SafeStartTime(Process process)
    {
        try
        {
            return process.StartTime;
        }
        catch
        {
            return DateTime.MaxValue;
        }
    }

    private static Dictionary<int, int> ReadParentProcesses()
    {
        var parents = new Dictionary<int, int>();
        IntPtr snapshot = CreateToolhelp32Snapshot(ProcessSnapshot, 0);
        if (snapshot == new IntPtr(-1))
        {
            return parents;
        }

        try
        {
            var entry = new ProcessEntry32
            {
                Size = (uint)Marshal.SizeOf<ProcessEntry32>(),
                ExecutableFile = string.Empty,
            };

            if (Process32First(snapshot, ref entry))
            {
                do
                {
                    parents[(int)entry.ProcessId] = (int)entry.ParentProcessId;
                }
                while (Process32Next(snapshot, ref entry));
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }

        return parents;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public UIntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExecutableFile;
    }
}
