using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace MinimalWaveBassHelper;

internal readonly record struct BassPayload(
    int V,
    bool Capturing,
    int Pid,
    int SampleRate,
    double SubDb,
    double Energy,
    double Onset,
    int ActiveMs,
    long CapturedAtUnixMs,
    double[]? Spectrum);

internal sealed class BassWebSocketServer : IAsyncDisposable
{
    private const string RequiredOrigin = "https://xpui.app.spotify.com";
    private const string RequiredPath = "/mwv-bass-v1";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly TcpListener _listener = new(IPAddress.Loopback, 43827);
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentDictionary<int, ClientConnection> _clients = new();
    private readonly Channel<BassPayload> _outgoing = Channel.CreateBounded<BassPayload>(
        new BoundedChannelOptions(1)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });
    private Task? _acceptTask;
    private Task? _sendTask;
    private int _nextClientId;

    public void Start()
    {
        _listener.Start();
        _acceptTask = AcceptLoopAsync(_stop.Token);
        _sendTask = SendLoopAsync(_stop.Token);
    }

    public void Publish(BassPayload payload)
    {
        _outgoing.Writer.TryWrite(payload);
    }

    private async Task AcceptLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                TcpClient client = await _listener.AcceptTcpClientAsync(cancellationToken);
                _ = HandleClientAsync(client, cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (SocketException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private async Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken)
    {
        ClientConnection? connection = null;

        try
        {
            client.NoDelay = true;
            client.SendBufferSize = 8192;
            NetworkStream stream = client.GetStream();
            string? headers = await ReadHeadersAsync(stream, cancellationToken);
            if (!TryValidateUpgrade(headers, out string? key))
            {
                byte[] forbidden = Encoding.ASCII.GetBytes("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(forbidden, cancellationToken);
                return;
            }

            string accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(
                key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            byte[] response = Encoding.ASCII.GetBytes(
                "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                $"Sec-WebSocket-Accept: {accept}\r\n\r\n");
            await stream.WriteAsync(response, cancellationToken);

            WebSocket socket = WebSocket.CreateFromStream(
                stream,
                isServer: true,
                subProtocol: null,
                keepAliveInterval: TimeSpan.FromSeconds(20));
            int id = Interlocked.Increment(ref _nextClientId);
            connection = new ClientConnection(client, socket);
            _clients[id] = connection;

            var receiveBuffer = new byte[64];
            while (socket.State is WebSocketState.Open or WebSocketState.CloseSent)
            {
                WebSocketReceiveResult result = await socket.ReceiveAsync(receiveBuffer, cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await socket.CloseOutputAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "closing",
                        CancellationToken.None);
                    break;
                }
            }

            _clients.TryRemove(id, out _);
        }
        catch (Exception error) when (
            error is IOException or SocketException or WebSocketException or OperationCanceledException)
        {
        }
        finally
        {
            connection?.Dispose();
            if (connection is null)
            {
                client.Dispose();
            }
        }
    }

    private async Task SendLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (await _outgoing.Reader.WaitToReadAsync(cancellationToken))
            {
                if (!TryReadLatest(_outgoing.Reader, out BassPayload latest))
                {
                    continue;
                }

                byte[] message = JsonSerializer.SerializeToUtf8Bytes(latest, JsonOptions);
                foreach ((int id, ClientConnection client) in _clients.ToArray())
                {
                    try
                    {
                        await client.Socket.SendAsync(
                            message,
                            WebSocketMessageType.Text,
                            endOfMessage: true,
                            cancellationToken);
                    }
                    catch (Exception error) when (
                        error is IOException or WebSocketException or OperationCanceledException)
                    {
                        if (_clients.TryRemove(id, out ClientConnection? removed))
                        {
                            removed.Dispose();
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    internal static bool TryReadLatest(ChannelReader<BassPayload> reader, out BassPayload latest)
    {
        latest = default;
        bool found = false;
        while (reader.TryRead(out BassPayload next))
        {
            latest = next;
            found = true;
        }
        return found;
    }

    private static async Task<string?> ReadHeadersAsync(Stream stream, CancellationToken cancellationToken)
    {
        var bytes = new List<byte>(1024);
        var buffer = new byte[512];

        while (bytes.Count < 8192)
        {
            int read = await stream.ReadAsync(buffer, cancellationToken);
            if (read == 0)
            {
                return null;
            }

            for (int index = 0; index < read; index++)
            {
                bytes.Add(buffer[index]);
            }

            int count = bytes.Count;
            if (count >= 4 && bytes[count - 4] == '\r' && bytes[count - 3] == '\n' &&
                bytes[count - 2] == '\r' && bytes[count - 1] == '\n')
            {
                return Encoding.ASCII.GetString(bytes.ToArray());
            }
        }

        return null;
    }

    private static bool TryValidateUpgrade(string? headers, out string? key)
    {
        key = null;
        if (string.IsNullOrEmpty(headers))
        {
            return false;
        }

        string[] lines = headers.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length == 0 || !lines[0].Equals($"GET {RequiredPath} HTTP/1.1", StringComparison.Ordinal))
        {
            return false;
        }

        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string line in lines.Skip(1))
        {
            int separator = line.IndexOf(':');
            if (separator > 0)
            {
                values[line[..separator].Trim()] = line[(separator + 1)..].Trim();
            }
        }

        values.TryGetValue("Sec-WebSocket-Key", out key);
        return !string.IsNullOrWhiteSpace(key) &&
            values.TryGetValue("Origin", out string? origin) &&
            origin.Equals(RequiredOrigin, StringComparison.OrdinalIgnoreCase) &&
            values.TryGetValue("Upgrade", out string? upgrade) &&
            upgrade.Equals("websocket", StringComparison.OrdinalIgnoreCase) &&
            values.TryGetValue("Sec-WebSocket-Version", out string? version) &&
            version == "13";
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        _outgoing.Writer.TryComplete();
        _listener.Stop();

        foreach (ClientConnection client in _clients.Values)
        {
            client.Dispose();
        }
        _clients.Clear();

        await IgnoreCancellation(_acceptTask);
        await IgnoreCancellation(_sendTask);
        _stop.Dispose();
    }

    private static async Task IgnoreCancellation(Task? task)
    {
        if (task is null)
        {
            return;
        }

        try
        {
            await task;
        }
        catch (OperationCanceledException)
        {
        }
    }

    private sealed class ClientConnection(TcpClient client, WebSocket socket) : IDisposable
    {
        public WebSocket Socket { get; } = socket;

        public void Dispose()
        {
            Socket.Dispose();
            client.Dispose();
        }
    }
}
