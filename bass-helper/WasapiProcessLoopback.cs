using System.Runtime.InteropServices;

namespace MinimalWaveBassHelper;

internal sealed class WasapiProcessLoopback : IDisposable
{
    private const string ProcessLoopbackDevice = "VAD\\Process_Loopback";
    private const uint StreamFlags = 0x0002_0000u | 0x8000_0000u;
    private const uint SilentBuffer = 0x2;
    private static readonly Guid AudioClientId = new("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    private static readonly Guid AudioCaptureClientId = new("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    private IAudioClient? _audioClient;
    private IAudioCaptureClient? _captureClient;

    public async Task RunAsync(
        int processId,
        BassAnalyzer analyzer,
        Func<bool> processExited,
        CancellationToken cancellationToken)
    {
        _audioClient = await ActivateAsync(processId, cancellationToken);
        IntPtr formatPointer = Marshal.AllocHGlobal(Marshal.SizeOf<WaveFormatEx>());

        try
        {
            var format = new WaveFormatEx
            {
                FormatTag = 1,
                Channels = 2,
                SamplesPerSecond = 44_100,
                AverageBytesPerSecond = 44_100 * 4,
                BlockAlign = 4,
                BitsPerSample = 16,
                ExtraSize = 0,
            };
            Marshal.StructureToPtr(format, formatPointer, false);

            ThrowIfFailed(_audioClient.Initialize(0, StreamFlags, 0, 0, formatPointer, IntPtr.Zero));
            ThrowIfFailed(_audioClient.GetService(AudioCaptureClientId, out object captureObject));
            _captureClient = (IAudioCaptureClient)captureObject;
            ThrowIfFailed(_audioClient.Start());

            while (!cancellationToken.IsCancellationRequested && !processExited())
            {
                DrainPackets(analyzer);
                await Task.Delay(5, cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        finally
        {
            if (_audioClient is not null)
            {
                _audioClient.Stop();
            }
            Marshal.FreeHGlobal(formatPointer);
        }
    }

    private unsafe void DrainPackets(BassAnalyzer analyzer)
    {
        if (_captureClient is null)
        {
            return;
        }

        while (true)
        {
            ThrowIfFailed(_captureClient.GetNextPacketSize(out uint frames));
            if (frames == 0)
            {
                return;
            }

            ThrowIfFailed(_captureClient.GetBuffer(
                out IntPtr data,
                out frames,
                out uint flags,
                IntPtr.Zero,
                IntPtr.Zero));

            try
            {
                if ((flags & SilentBuffer) != 0 || data == IntPtr.Zero)
                {
                    analyzer.PushSilence((int)frames);
                }
                else
                {
                    analyzer.PushPcm16(new ReadOnlySpan<short>((void*)data, checked((int)frames * 2)));
                }
            }
            finally
            {
                ThrowIfFailed(_captureClient.ReleaseBuffer(frames));
            }
        }
    }

    private static async Task<IAudioClient> ActivateAsync(int processId, CancellationToken cancellationToken)
    {
        var completion = new ActivationCompletionHandler();
        var parameters = new AudioClientActivationParameters
        {
            ActivationType = 1,
            TargetProcessId = (uint)processId,
            ProcessLoopbackMode = 0,
        };
        IntPtr parameterPointer = Marshal.AllocHGlobal(Marshal.SizeOf<AudioClientActivationParameters>());
        Marshal.StructureToPtr(parameters, parameterPointer, false);

        try
        {
            var variant = new PropVariant
            {
                VariantType = 65,
                Blob = new Blob
                {
                    Size = Marshal.SizeOf<AudioClientActivationParameters>(),
                    Data = parameterPointer,
                },
            };
            Guid iid = AudioClientId;
            ThrowIfFailed(ActivateAudioInterfaceAsync(
                ProcessLoopbackDevice,
                ref iid,
                ref variant,
                completion,
                out IActivateAudioInterfaceAsyncOperation operation));

            IAudioClient result = await completion.Task.WaitAsync(TimeSpan.FromSeconds(8), cancellationToken);
            GC.KeepAlive(operation);
            return result;
        }
        finally
        {
            Marshal.FreeHGlobal(parameterPointer);
        }
    }

    public void Dispose()
    {
        ReleaseComObject(_captureClient);
        ReleaseComObject(_audioClient);
        _captureClient = null;
        _audioClient = null;
    }

    private static void ReleaseComObject(object? value)
    {
        if (value is not null && Marshal.IsComObject(value))
        {
            Marshal.FinalReleaseComObject(value);
        }
    }

    private static void ThrowIfFailed(int result)
    {
        if (result < 0)
        {
            Marshal.ThrowExceptionForHR(result);
        }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int ActivateAudioInterfaceAsync(
        string deviceInterfacePath,
        ref Guid interfaceId,
        ref PropVariant activationParameters,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioClientActivationParameters
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Blob
    {
        public int Size;
        public IntPtr Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort VariantType;
        [FieldOffset(8)] public Blob Blob;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormatEx
    {
        public ushort FormatTag;
        public ushort Channels;
        public uint SamplesPerSecond;
        public uint AverageBytesPerSecond;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort ExtraSize;
    }

    [Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig]
        int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport]
    [Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig]
        int GetActivateResult(out int activateResult, out IntPtr activatedInterface);
    }

    [ComImport]
    [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig]
        int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig]
        int GetBufferSize(out uint bufferFrames);
        [PreserveSig]
        int GetStreamLatency(out long latency);
        [PreserveSig]
        int GetCurrentPadding(out uint paddingFrames);
        [PreserveSig]
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig]
        int GetMixFormat(out IntPtr format);
        [PreserveSig]
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig]
        int Start();
        [PreserveSig]
        int Stop();
        [PreserveSig]
        int Reset();
        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);
        [PreserveSig]
        int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid interfaceId, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport]
    [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(out IntPtr data, out uint frames, out uint flags, IntPtr devicePosition, IntPtr qpcPosition);
        [PreserveSig]
        int ReleaseBuffer(uint frames);
        [PreserveSig]
        int GetNextPacketSize(out uint frames);
    }

    private sealed class ActivationCompletionHandler : IActivateAudioInterfaceCompletionHandler
    {
        private readonly TaskCompletionSource<IAudioClient> _completion =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<IAudioClient> Task => _completion.Task;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try
            {
                int result = operation.GetActivateResult(out int activationResult, out IntPtr activatedInterface);
                ThrowIfFailed(result);
                ThrowIfFailed(activationResult);

                try
                {
                    _completion.TrySetResult((IAudioClient)Marshal.GetObjectForIUnknown(activatedInterface));
                }
                finally
                {
                    if (activatedInterface != IntPtr.Zero)
                    {
                        Marshal.Release(activatedInterface);
                    }
                }
            }
            catch (Exception error)
            {
                _completion.TrySetException(error);
            }

            return 0;
        }
    }
}
