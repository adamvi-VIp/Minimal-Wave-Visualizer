using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MinimalWaveBassHelper;

internal readonly record struct SpotifyLaunchRequest(
    bool ShouldLaunch,
    string? StoreAumid,
    string[] Arguments);

internal static class SpotifyLauncher
{
    internal const string LaunchSwitch = "--launch-spotify";
    internal const string AumidPrefix = "--spotify-aumid=";

    public static SpotifyLaunchRequest Parse(string[] args)
    {
        string? aumidArgument = args
            .FirstOrDefault(argument => argument.StartsWith(AumidPrefix, StringComparison.OrdinalIgnoreCase));
        string? aumid = aumidArgument is null
            ? null
            : aumidArgument[AumidPrefix.Length..].Trim('"');
        int launchIndex = Array.FindIndex(
            args,
            argument => string.Equals(argument, LaunchSwitch, StringComparison.OrdinalIgnoreCase));
        string[] arguments = launchIndex < 0
            ? []
            : args[(launchIndex + 1)..]
                .Where(argument => !argument.StartsWith(AumidPrefix, StringComparison.OrdinalIgnoreCase))
                .ToArray();

        return new SpotifyLaunchRequest(launchIndex >= 0, string.IsNullOrWhiteSpace(aumid) ? null : aumid, arguments);
    }

    public static bool TryLaunch(SpotifyLaunchRequest request) =>
        request.StoreAumid is null
            ? TryLaunchClassic(request.Arguments)
            : TryLaunchStore(request.StoreAumid, request.Arguments);

    public static string ProtocolCommand(string helperPath, string? storeAumid)
    {
        string target = $"\"{helperPath}\" {LaunchSwitch}";
        if (!string.IsNullOrWhiteSpace(storeAumid))
        {
            target += $" {AumidPrefix}\"{storeAumid}\"";
        }

        return target + " --protocol-uri=\"%1\" " +
            "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding";
    }

    private static bool TryLaunchClassic(IEnumerable<string> arguments)
    {
        string spotifyPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Spotify",
            "Spotify.exe");
        if (!File.Exists(spotifyPath))
        {
            return false;
        }

        var startInfo = new ProcessStartInfo(spotifyPath)
        {
            UseShellExecute = false,
        };
        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process? process = Process.Start(startInfo);
        return process is not null;
    }

    private static bool TryLaunchStore(string aumid, string[] arguments)
    {
        object activationObject = new ApplicationActivationManager();
        var activationManager = (IApplicationActivationManager)activationObject;

        try
        {
            string? protocolArgument = arguments
                .FirstOrDefault(argument => argument.StartsWith("--protocol-uri=", StringComparison.OrdinalIgnoreCase));
            string? protocolUri = protocolArgument is null
                ? null
                : protocolArgument["--protocol-uri=".Length..].Trim('"');

            if (!string.IsNullOrWhiteSpace(protocolUri) && TryActivateProtocol(activationManager, aumid, protocolUri))
            {
                return true;
            }

            string commandLine = string.Join(" ", arguments.Select(QuoteArgument));
            int result = activationManager.ActivateApplication(aumid, commandLine, ActivateOptions.None, out uint processId);
            return result >= 0 && processId > 0;
        }
        catch (COMException)
        {
            return false;
        }
        finally
        {
            Marshal.FinalReleaseComObject(activationObject);
        }
    }

    private static bool TryActivateProtocol(
        IApplicationActivationManager activationManager,
        string aumid,
        string protocolUri)
    {
        IShellItem? item = null;
        IShellItemArray? items = null;

        try
        {
            Guid shellItemId = typeof(IShellItem).GUID;
            int itemResult = SHCreateItemFromParsingName(protocolUri, IntPtr.Zero, ref shellItemId, out item);
            if (itemResult < 0 || item is null)
            {
                return false;
            }

            Guid arrayId = typeof(IShellItemArray).GUID;
            int arrayResult = SHCreateShellItemArrayFromShellItem(item, ref arrayId, out items);
            if (arrayResult < 0 || items is null)
            {
                return false;
            }

            int result = activationManager.ActivateForProtocol(aumid, items, out uint processId);
            return result >= 0 && processId > 0;
        }
        catch (COMException)
        {
            return false;
        }
        finally
        {
            if (items is not null)
            {
                Marshal.FinalReleaseComObject(items);
            }
            if (item is not null)
            {
                Marshal.FinalReleaseComObject(item);
            }
        }
    }

    private static string QuoteArgument(string argument) =>
        argument.Length > 0 && !argument.Any(char.IsWhiteSpace) && !argument.Contains('"')
            ? argument
            : $"\"{argument.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"";

    [Flags]
    private enum ActivateOptions
    {
        None = 0,
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private sealed class ApplicationActivationManager
    {
    }

    [ComImport]
    [Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId);

        [PreserveSig]
        int ActivateForFile(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IShellItemArray itemArray,
            [MarshalAs(UnmanagedType.LPWStr)] string verb,
            out uint processId);

        [PreserveSig]
        int ActivateForProtocol(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IShellItemArray itemArray,
            out uint processId);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
    }

    [ComImport]
    [Guid("B63EA76D-1F85-456F-A19C-48159EFA858B")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemArray
    {
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
        string path,
        IntPtr bindingContext,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHCreateShellItemArrayFromShellItem(
        IShellItem shellItem,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemArray shellItemArray);
}
