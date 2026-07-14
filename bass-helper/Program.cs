using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Channels;
using Microsoft.Win32;

namespace MinimalWaveBassHelper;

internal static class Program
{
    private const int SampleRate = 44_100;
    private const string SpotifyProtocolRegistryPath = @"Software\Classes\spotify\shell\open\command";
    private static readonly TimeSpan SpotifyStartupTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan SpotifyShutdownGrace = TimeSpan.FromSeconds(5);

    public static async Task<int> Main(string[] args)
    {
        if (args.Contains("--self-check", StringComparer.OrdinalIgnoreCase))
        {
            RunSelfCheck();
            Console.WriteLine("MinimalWaveBassHelper self-check passed.");
            return 0;
        }

        SpotifyLaunchRequest launchRequest = SpotifyLauncher.Parse(args);
        if (launchRequest.ShouldLaunch && !SpotifyLauncher.TryLaunch(launchRequest))
        {
            return 1;
        }

        using var mutex = new Mutex(
            initiallyOwned: true,
            name: "Local\\MinimalWaveVisualizerBassHelper",
            createdNew: out bool ownsMutex);
        if (!ownsMutex)
        {
            return 0;
        }

        using var stop = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            stop.Cancel();
        };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => stop.Cancel();

        await using var server = new BassWebSocketServer();
        server.Start();
        Task protocolMaintenance = MaintainProtocolHandlerAsync(launchRequest.StoreAumid, stop.Token);
        long startedAt = Stopwatch.GetTimestamp();
        long missingSince = startedAt;
        bool sawSpotify = false;

        while (!stop.IsCancellationRequested)
        {
            using Process? spotify = SpotifyProcessFinder.FindRoot();
            if (spotify is null)
            {
                server.Publish(UnavailablePayload());
                if (ShouldStopForSpotifyAbsence(
                    sawSpotify,
                    Stopwatch.GetElapsedTime(missingSince),
                    Stopwatch.GetElapsedTime(startedAt)))
                {
                    break;
                }

                await DelayWithoutThrow(500, stop.Token);
                continue;
            }

            sawSpotify = true;
            missingSince = Stopwatch.GetTimestamp();

            try
            {
                int processId = spotify.Id;
                var analyzer = new BassAnalyzer(SampleRate, 2);
                analyzer.FrameReady += frame => server.Publish(CreatePayload(
                    processId,
                    frame,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));

                using var capture = new WasapiProcessLoopback();
                await capture.RunAsync(processId, analyzer, () => HasExited(spotify), stop.Token);
            }
            catch (Exception error) when (
                error is COMException or InvalidCastException or TimeoutException or OperationCanceledException)
            {
                Debug.WriteLine(error);
            }

            server.Publish(UnavailablePayload());
            missingSince = Stopwatch.GetTimestamp();
            await DelayWithoutThrow(500, stop.Token);
        }

        stop.Cancel();
        await protocolMaintenance;
        return 0;
    }

    private static BassPayload CreatePayload(int processId, BassFrame frame, long capturedAtUnixMs) => new(
        1,
        true,
        processId,
        SampleRate,
        Math.Round(frame.SubDb, 2),
        Math.Round(frame.Energy, 4),
        Math.Round(frame.Onset, 4),
        frame.ActiveMs,
        capturedAtUnixMs,
        frame.Spectrum);

    private static BassPayload UnavailablePayload() => new(
        1,
        false,
        0,
        SampleRate,
        -120,
        0,
        0,
        0,
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        null);

    private static async Task MaintainProtocolHandlerAsync(string? storeAumid, CancellationToken cancellationToken)
    {
        string? helperPath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(helperPath))
        {
            return;
        }

        string expected = SpotifyLauncher.ProtocolCommand(helperPath, storeAumid);
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                using RegistryKey key = Registry.CurrentUser.CreateSubKey(SpotifyProtocolRegistryPath, true);
                if (!string.Equals(key.GetValue("") as string, expected, StringComparison.Ordinal))
                {
                    key.SetValue("", expected, RegistryValueKind.String);
                }
            }
            catch (Exception error) when (error is UnauthorizedAccessException or IOException)
            {
                Debug.WriteLine(error);
            }

            await DelayWithoutThrow(2000, cancellationToken);
        }
    }

    private static bool ShouldStopForSpotifyAbsence(bool sawSpotify, TimeSpan absentFor, TimeSpan runningFor) =>
        sawSpotify ? absentFor >= SpotifyShutdownGrace : runningFor >= SpotifyStartupTimeout;

    private static bool HasExited(Process process)
    {
        try
        {
            return process.HasExited;
        }
        catch
        {
            return true;
        }
    }

    private static async Task DelayWithoutThrow(int milliseconds, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(milliseconds, cancellationToken);
        }
        catch (OperationCanceledException)
        {
        }
    }

    private static void RunSelfCheck()
    {
        int[] boundaries = BassAnalyzer.SpectrumBoundaries(SampleRate, 56);
        BassFrame sine50 = AnalyzeTone(50, 0.35, 0.7);
        BassFrame sine75 = AnalyzeTone(75, 0.35, 0.7);
        BassFrame sine80 = AnalyzeTone(80, 0.35, 0.7);
        BassFrame sine85 = AnalyzeTone(85, 0.35, 0.7);
        BassFrame sine90 = AnalyzeTone(90, 0.35, 0.7);
        BassFrame sine200 = AnalyzeTone(200, 0.35, 0.7);
        BassFrame sine1000 = AnalyzeTone(1000, 0.35, 0.7);
        BassFrame sine8000 = AnalyzeTone(8000, 0.35, 0.7);
        BassFrame mixed = AnalyzeTones([(50, 0.35), (1000, 0.35)], 0.7);
        BassFrame balancedMix = AnalyzeTones(
            [(50, 0.12), (250, 0.12), (1000, 0.12), (4000, 0.12), (12000, 0.12)],
            0.7);
        BassFrame shortBass = AnalyzeTone(50, 0.35, 0.12);
        BassFrame antiPhase = AnalyzeTone(50, 0.35, 0.7, antiPhase: true);
        BassPayload timestampedPayload = CreatePayload(42, sine50, 123456);
        Channel<BassPayload> payloads = Channel.CreateBounded<BassPayload>(new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
        });
        payloads.Writer.TryWrite(timestampedPayload with { CapturedAtUnixMs = 1 });
        payloads.Writer.TryWrite(timestampedPayload with { CapturedAtUnixMs = 2 });
        SpotifyLaunchRequest launchRequest = SpotifyLauncher.Parse(
            ["ignored", SpotifyLauncher.LaunchSwitch, "--autostart", "--minimized"]);
        SpotifyLaunchRequest storeLaunchRequest = SpotifyLauncher.Parse(
            [SpotifyLauncher.AumidPrefix + "SpotifyAB.SpotifyMusic_test!Spotify", SpotifyLauncher.LaunchSwitch, "--minimized"]);

        Require(boundaries.Length == 57 && boundaries.Zip(boundaries.Skip(1)).All(pair => pair.First < pair.Second),
            "all 56 visualizer bands should have unique, strictly increasing FFT-bin boundaries");
        Require(sine50.Energy >= 0.72, $"50 Hz energy too weak: {sine50.Energy:F3}");
        Require(sine75.Energy >= 0.65, $"75 Hz energy too weak: {sine75.Energy:F3}");
        Require(sine80.Energy >= 0.45, $"80 Hz energy too weak: {sine80.Energy:F3}");
        Require(sine85.Energy <= 0.18, $"85 Hz leaked into sub band: {sine85.Energy:F3}");
        Require(sine90.Energy <= 0.08, $"90 Hz leaked into sub band: {sine90.Energy:F3}");
        Require(sine200.Energy <= 0.08, $"200 Hz leaked into sub band: {sine200.Energy:F3}");
        Require(sine1000.Energy <= 0.08, $"1 kHz leaked into sub band: {sine1000.Energy:F3}");
        Require(mixed.Energy >= sine50.Energy * 0.9, "high-frequency content masked the 50 Hz result");
        Require(antiPhase.Energy >= sine50.Energy * 0.9, "stereo phase cancellation removed sub-bass");
        Require(timestampedPayload.Pid == 42 && timestampedPayload.CapturedAtUnixMs == 123456,
            "native payloads should preserve their capture timestamp");
        Require(BassWebSocketServer.TryReadLatest(payloads.Reader, out BassPayload latestPayload) &&
            latestPayload.CapturedAtUnixMs == 2,
            "bounded output should coalesce queued FFT frames to the newest payload");
        Require(launchRequest.ShouldLaunch && launchRequest.StoreAumid is null &&
            launchRequest.Arguments.SequenceEqual(["--autostart", "--minimized"]),
            "launcher mode should forward Spotify arguments without re-parsing them");
        Require(storeLaunchRequest.ShouldLaunch &&
            storeLaunchRequest.StoreAumid == "SpotifyAB.SpotifyMusic_test!Spotify" &&
            storeLaunchRequest.Arguments.SequenceEqual(["--minimized"]),
            "Store launcher mode should preserve the AUMID without forwarding it to Spotify");
        Require(SpotifyLauncher.ProtocolCommand(@"C:\Path With Space\MinimalWaveBassHelper.exe", null) ==
            "\"C:\\Path With Space\\MinimalWaveBassHelper.exe\" --launch-spotify --protocol-uri=\"%1\" " +
            "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding",
            "protocol repair should quote the helper and preserve Spotify background flags");
        Require(SpotifyLauncher.ProtocolCommand(@"C:\Path With Space\MinimalWaveBassHelper.exe", "SpotifyAB.Test!Spotify") ==
            "\"C:\\Path With Space\\MinimalWaveBassHelper.exe\" --launch-spotify " +
            "--spotify-aumid=\"SpotifyAB.Test!Spotify\" --protocol-uri=\"%1\" " +
            "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding",
            "Store protocol repair should preserve the package AUMID");
        Require(!ShouldStopForSpotifyAbsence(true, TimeSpan.FromSeconds(4.9), TimeSpan.FromMinutes(1)) &&
            ShouldStopForSpotifyAbsence(true, TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1)) &&
            !ShouldStopForSpotifyAbsence(false, TimeSpan.FromMinutes(1), TimeSpan.FromSeconds(29.9)) &&
            ShouldStopForSpotifyAbsence(false, TimeSpan.FromMinutes(1), TimeSpan.FromSeconds(30)),
            "helper lifetime should tolerate startup/restart gaps and stop after Spotify closes");
        Require(shortBass.ActiveMs > 0 && shortBass.ActiveMs < sine50.ActiveMs,
            "short and sustained bass should report different active durations");
        int peak50 = PeakIndex(sine50.Spectrum);
        int peak1000 = PeakIndex(sine1000.Spectrum);
        int peak8000 = PeakIndex(sine8000.Spectrum);
        Require(peak50 < 14, "50 Hz should peak on the low visualizer bars");
        Require(peak1000 is >= 27 and <= 38,
            "1 kHz should peak near the middle-right visualizer bars");
        Require(peak8000 >= 42, "8 kHz should peak on the high visualizer bars");
        Require(peak50 < peak1000 && peak1000 < peak8000,
            $"spectrum peaks should increase with frequency: {peak50}, {peak1000}, {peak8000}");
        double[] regionPeaks = [
            balancedMix.Spectrum[0..14].Max(),
            balancedMix.Spectrum[14..28].Max(),
            balancedMix.Spectrum[28..42].Max(),
            balancedMix.Spectrum[42..56].Max(),
        ];
        Require(regionPeaks.Min() >= regionPeaks.Max() * 0.6,
            $"equal representative tones should stay visible across the spectrum: {string.Join(", ", regionPeaks.Select(value => value.ToString("F3")))}");
        Require(balancedMix.Spectrum.Max() - balancedMix.Spectrum.Min() >= 0.2,
            "balanced tones should retain distinct band heights");

        var silenceAnalyzer = new BassAnalyzer(SampleRate, 2);
        BassFrame afterSilence = default;
        silenceAnalyzer.FrameReady += next => afterSilence = next;
        silenceAnalyzer.PushPcm16(GenerateTone(50, 0.35, 0.35));
        silenceAnalyzer.PushPcm16(new short[(int)(SampleRate * 0.35) * 2]);
        Require(afterSilence.Energy <= 0.01 && afterSilence.Onset <= 0.01 && afterSilence.ActiveMs == 0,
            "silence should clear energy, onset, and active duration");
        Require(afterSilence.Spectrum.All(value => value <= 0.001),
            "silence should clear every visualizer frequency band");
    }

    private static int PeakIndex(double[] values)
    {
        int peak = 0;
        for (int index = 1; index < values.Length; index++)
        {
            if (values[index] > values[peak])
            {
                peak = index;
            }
        }
        return peak;
    }

    private static BassFrame AnalyzeTone(
        double frequency,
        double amplitude,
        double seconds,
        bool antiPhase = false)
    {
        var analyzer = new BassAnalyzer(SampleRate, 2);
        BassFrame frame = default;

        analyzer.FrameReady += next => frame = next;
        analyzer.PushPcm16(GenerateTone(frequency, amplitude, seconds, antiPhase));
        return frame;
    }

    private static BassFrame AnalyzeTones((double Frequency, double Amplitude)[] tones, double seconds)
    {
        var analyzer = new BassAnalyzer(SampleRate, 2);
        BassFrame frame = default;
        int frames = (int)(SampleRate * seconds);
        var samples = new short[frames * 2];

        for (int index = 0; index < frames; index++)
        {
            double mixed = tones.Sum(tone =>
                Math.Sin(2 * Math.PI * tone.Frequency * index / SampleRate) * tone.Amplitude);
            short value = (short)Math.Round(Math.Clamp(mixed, -1, 1) * short.MaxValue);
            samples[index * 2] = value;
            samples[index * 2 + 1] = value;
        }

        analyzer.FrameReady += next => frame = next;
        analyzer.PushPcm16(samples);
        return frame;
    }

    private static short[] GenerateTone(
        double frequency,
        double amplitude,
        double seconds,
        bool antiPhase = false)
    {
        int frames = (int)(SampleRate * seconds);
        var samples = new short[frames * 2];

        for (int frame = 0; frame < frames; frame++)
        {
            short value = (short)Math.Round(
                Math.Sin(2 * Math.PI * frequency * frame / SampleRate) * amplitude * short.MaxValue);
            samples[frame * 2] = value;
            samples[frame * 2 + 1] = antiPhase ? (short)-value : value;
        }

        return samples;
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }
}
