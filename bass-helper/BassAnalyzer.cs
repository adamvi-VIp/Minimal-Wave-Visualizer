namespace MinimalWaveBassHelper;

internal readonly record struct BassFrame(
    double SubDb,
    double Energy,
    double Onset,
    int ActiveMs,
    double[] Spectrum);

internal sealed class BassAnalyzer
{
    internal const int WindowSize = 4096;
    internal const int HopSize = 1024;

    private readonly int _sampleRate;
    private readonly int _channels;
    private readonly double[] _left = new double[WindowSize];
    private readonly double[] _right = new double[WindowSize];
    private readonly double[] _real = new double[WindowSize];
    private readonly double[] _imaginary = new double[WindowSize];
    private readonly double[] _leftPower = new double[WindowSize / 2 + 1];
    private readonly double[] _power = new double[WindowSize / 2 + 1];
    private readonly double[] _window = new double[WindowSize];
    private readonly double _windowSum;
    private int _writeIndex;
    private int _filled;
    private int _sinceAnalysis;
    private double _previousSubDb = -120;
    private int _activeMs;
    private int _quietFrames;

    public BassAnalyzer(int sampleRate, int channels)
    {
        if (sampleRate <= 0 || channels <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(sampleRate));
        }

        _sampleRate = sampleRate;
        _channels = channels;

        for (int index = 0; index < WindowSize; index++)
        {
            _window[index] = 0.5 - 0.5 * Math.Cos(2 * Math.PI * index / (WindowSize - 1));
            _windowSum += _window[index];
        }
    }

    public event Action<BassFrame>? FrameReady;

    public void PushPcm16(ReadOnlySpan<short> samples)
    {
        int frameCount = samples.Length / _channels;

        for (int frame = 0; frame < frameCount; frame++)
        {
            int offset = frame * _channels;
            PushFrame(
                samples[offset] / 32768d,
                samples[offset + Math.Min(1, _channels - 1)] / 32768d);
        }
    }

    public void PushSilence(int frameCount)
    {
        for (int frame = 0; frame < frameCount; frame++)
        {
            PushFrame(0, 0);
        }
    }

    private void PushFrame(double left, double right)
    {
        _left[_writeIndex] = left;
        _right[_writeIndex] = right;
        _writeIndex = (_writeIndex + 1) % WindowSize;
        _filled = Math.Min(WindowSize, _filled + 1);
        _sinceAnalysis += 1;

        if (_filled == WindowSize && _sinceAnalysis >= HopSize)
        {
            _sinceAnalysis = 0;
            FrameReady?.Invoke(Analyze());
        }
    }

    private BassFrame Analyze()
    {
        FillSpectrum(_left, _leftPower);
        FillSpectrum(_right, null);

        for (int bin = 0; bin < _power.Length; bin++)
        {
            _power[bin] = (_leftPower[bin] + BinPower(bin)) * 0.5;
        }

        int firstBin = (int)Math.Ceiling(20d * WindowSize / _sampleRate);
        int lastBin = (int)Math.Floor(80d * WindowSize / _sampleRate);
        int guardLastBin = (int)Math.Floor(140d * WindowSize / _sampleRate);
        double subPower = 0;
        double guardPower = 0;

        for (int bin = firstBin; bin <= lastBin; bin++)
        {
            subPower += _power[bin];
        }

        for (int bin = lastBin + 1; bin <= guardLastBin; bin++)
        {
            guardPower += _power[bin];
        }

        double power = Math.Max(0, subPower - guardPower * 0.55);
        double subDb = 10 * Math.Log10(Math.Max(power, 1e-12));
        double energy = Math.Pow(Math.Clamp((subDb + 54) / 36, 0, 1), 0.65);
        double onset = Math.Clamp((subDb - _previousSubDb) / 10, 0, 1) * Math.Sqrt(energy);
        _previousSubDb = subDb;

        if (energy >= 0.08)
        {
            _quietFrames = 0;
            _activeMs += (int)Math.Round(HopSize * 1000d / _sampleRate);
        }
        else if (++_quietFrames >= 2)
        {
            _activeMs = 0;
        }

        return new BassFrame(subDb, energy, onset, _activeMs, BuildSpectrum(56));
    }

    private double[] BuildSpectrum(int count)
    {
        int[] boundaries = SpectrumBoundaries(_sampleRate, count);
        var spectrum = new double[count];

        for (int index = 0; index < count; index++)
        {
            double power = 0;

            for (int bin = boundaries[index]; bin < boundaries[index + 1]; bin++)
            {
                power += _power[bin];
            }

            double decibels = 10 * Math.Log10(Math.Max(power, 1e-12));
            spectrum[index] = Math.Round(
                Math.Pow(Math.Clamp((decibels + 66) / 54, 0, 1), 0.78),
                4);
        }

        return spectrum;
    }

    internal static int[] SpectrumBoundaries(int sampleRate, int count)
    {
        const double minimumFrequency = 20;
        double maximumFrequency = Math.Min(16_000, sampleRate * 0.5);
        int firstBin = Math.Max(1, (int)Math.Ceiling(minimumFrequency * WindowSize / sampleRate));
        int endBin = Math.Min(WindowSize / 2 + 1, (int)Math.Floor(maximumFrequency * WindowSize / sampleRate) + 1);
        var boundaries = new int[count + 1];

        boundaries[0] = firstBin;
        boundaries[count] = endBin;
        for (int index = 1; index < count; index++)
        {
            int desired = (int)Math.Round(firstBin * Math.Pow(endBin / (double)firstBin, index / (double)count));
            boundaries[index] = Math.Clamp(
                desired,
                boundaries[index - 1] + 1,
                endBin - (count - index));
        }

        return boundaries;
    }

    private void FillSpectrum(double[] source, double[]? destination)
    {
        for (int index = 0; index < WindowSize; index++)
        {
            _real[index] = source[(_writeIndex + index) % WindowSize] * _window[index];
            _imaginary[index] = 0;
        }

        Fft(_real, _imaginary);

        if (destination is not null)
        {
            for (int bin = 0; bin < destination.Length; bin++)
            {
                destination[bin] = BinPower(bin);
            }
        }
    }

    private double BinPower(int bin)
    {
        double amplitude = 2 * Math.Sqrt(
            _real[bin] * _real[bin] + _imaginary[bin] * _imaginary[bin]) / _windowSum;
        return amplitude * amplitude;
    }

    private static void Fft(double[] real, double[] imaginary)
    {
        int length = real.Length;

        for (int index = 1, reversed = 0; index < length; index++)
        {
            int bit = length >> 1;
            for (; (reversed & bit) != 0; bit >>= 1)
            {
                reversed ^= bit;
            }
            reversed ^= bit;

            if (index < reversed)
            {
                (real[index], real[reversed]) = (real[reversed], real[index]);
                (imaginary[index], imaginary[reversed]) = (imaginary[reversed], imaginary[index]);
            }
        }

        for (int size = 2; size <= length; size <<= 1)
        {
            double angle = -2 * Math.PI / size;
            double stepReal = Math.Cos(angle);
            double stepImaginary = Math.Sin(angle);

            for (int start = 0; start < length; start += size)
            {
                double twiddleReal = 1;
                double twiddleImaginary = 0;

                for (int offset = 0; offset < size / 2; offset++)
                {
                    int even = start + offset;
                    int odd = even + size / 2;
                    double oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
                    double oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;

                    real[odd] = real[even] - oddReal;
                    imaginary[odd] = imaginary[even] - oddImaginary;
                    real[even] += oddReal;
                    imaginary[even] += oddImaginary;

                    double nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
                    twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
                    twiddleReal = nextReal;
                }
            }
        }
    }
}
