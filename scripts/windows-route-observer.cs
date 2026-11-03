using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

internal static class WindowsRouteObserver
{
    private const int Render = 0;
    private const int ConsoleRole = 0;
    private const uint ActiveDevice = 1;
    private const uint ClsctxAll = 23;
    private const int SessionActive = 1;
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class DeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object value);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(ref Guid sessionGuid, uint flags, out IAudioSessionControl control);
        [PreserveSig] int GetSimpleAudioVolume(ref Guid sessionGuid, uint flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl control);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
        [PreserveSig] int GetGroupingParam(out Guid grouping);
        [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
        [PreserveSig] int GetGroupingParam(out Guid grouping);
        [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetProcessId(out uint processId);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestFormat);
        [PreserveSig] int GetMixFormat(out IntPtr format);
    }

    private sealed class Route
    {
        internal string EndpointId;
        internal string SessionId;
        internal uint ProcessId;
        internal int Rate;
        internal int Channels;
        internal string SampleFormat;
    }

    private sealed class Observation
    {
        internal int SessionCount;
        internal readonly List<Route> Matches = new List<Route>();
    }

    private sealed class NoRenderSessionsException : InvalidOperationException
    {
        internal NoRenderSessionsException() : base("no active render sessions") { }
    }

    private sealed class NoMatchingSessionException : InvalidOperationException
    {
        internal NoMatchingSessionException() : base("no active render session for process") { }
    }

    private sealed class MultipleMatchingSessionsException : InvalidOperationException
    {
        internal MultipleMatchingSessionsException() : base("expected exactly one active render session for process") { }
    }

    private sealed class NonDefaultEndpointException : InvalidOperationException
    {
        internal NonDefaultEndpointException() : base("render session is not on the default endpoint") { }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        uint processId;
        if (args.Length != 1 || !UInt32.TryParse(args[0], NumberStyles.None, CultureInfo.InvariantCulture, out processId) || processId == 0)
        {
            Console.Error.WriteLine("usage: windows-route-observer <process-id>");
            return 2;
        }

        try
        {
            Route route = FindOnlyRoute(processId);
            Console.Out.WriteLine("{\"process_id\":" + route.ProcessId.ToString(CultureInfo.InvariantCulture)
                + ",\"endpoint_id\":\"" + Escape(route.EndpointId)
                + "\",\"session_id\":\"" + Escape(route.SessionId)
                + "\",\"rate\":" + route.Rate.ToString(CultureInfo.InvariantCulture)
                + ",\"channels\":" + route.Channels.ToString(CultureInfo.InvariantCulture)
                + ",\"sample_format\":\"" + Escape(route.SampleFormat) + "\"}");
            return 0;
        }
        catch (NoRenderSessionsException error)
        {
            Console.Error.WriteLine(error.Message);
            return 3;
        }
        catch (NoMatchingSessionException error)
        {
            Console.Error.WriteLine(error.Message);
            return 4;
        }
        catch (MultipleMatchingSessionsException error)
        {
            Console.Error.WriteLine(error.Message);
            return 5;
        }
        catch (NonDefaultEndpointException error)
        {
            Console.Error.WriteLine(error.Message);
            return 6;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static Route FindOnlyRoute(uint targetProcessId)
    {
        IMMDeviceEnumerator enumerator = null;
        IMMDeviceCollection devices = null;
        string defaultEndpointId = null;
        var observation = new Observation();
        try
        {
            enumerator = (IMMDeviceEnumerator)new DeviceEnumerator();
            IMMDevice defaultDevice = null;
            try
            {
                Check(enumerator.GetDefaultAudioEndpoint(Render, ConsoleRole, out defaultDevice), "read default render endpoint");
                Check(defaultDevice.GetId(out defaultEndpointId), "read default endpoint identifier");
            }
            finally { Release(defaultDevice); }
            if (String.IsNullOrEmpty(defaultEndpointId)) throw new InvalidOperationException("default endpoint identifier is empty");
            Check(enumerator.EnumAudioEndpoints(Render, ActiveDevice, out devices), "enumerate active render endpoints");
            uint count;
            Check(devices.GetCount(out count), "count render endpoints");
            for (uint index = 0; index < count; index++) FindRoutesOnDevice(devices, index, targetProcessId, observation);
        }
        finally
        {
            Release(devices);
            Release(enumerator);
        }

        if (observation.SessionCount == 0) throw new NoRenderSessionsException();
        if (observation.Matches.Count == 0) throw new NoMatchingSessionException();
        if (observation.Matches.Count != 1) throw new MultipleMatchingSessionsException();
        Route result = observation.Matches[0];
        if (result.EndpointId != defaultEndpointId) throw new NonDefaultEndpointException();
        return result;
    }

    private static void FindRoutesOnDevice(IMMDeviceCollection devices, uint index, uint targetProcessId, Observation observation)
    {
        IMMDevice device = null;
        IAudioSessionManager2 manager = null;
        IAudioSessionEnumerator sessions = null;
        try
        {
            Check(devices.Item(index, out device), "read render endpoint");
            Guid managerId = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
            object managerObject;
            Check(device.Activate(ref managerId, ClsctxAll, IntPtr.Zero, out managerObject), "open session manager");
            manager = (IAudioSessionManager2)managerObject;
            Check(manager.GetSessionEnumerator(out sessions), "enumerate render sessions");
            int count;
            Check(sessions.GetCount(out count), "count render sessions");
            observation.SessionCount += count;
            for (int sessionIndex = 0; sessionIndex < count; sessionIndex++) FindRoute(device, sessions, sessionIndex, targetProcessId, observation);
        }
        finally
        {
            Release(sessions);
            Release(manager);
            Release(device);
        }
    }

    private static void FindRoute(IMMDevice device, IAudioSessionEnumerator sessions, int index, uint targetProcessId, Observation observation)
    {
        IAudioSessionControl raw = null;
        try
        {
            Check(sessions.GetSession(index, out raw), "read render session");
            var session = (IAudioSessionControl2)raw;
            uint owner;
            int state;
            int processResult = session.GetProcessId(out owner);
            if (processResult != 0) return;
            Check(session.GetState(out state), "read session state");
            if (owner != targetProcessId || state != SessionActive) return;
            string sessionId;
            Check(session.GetSessionInstanceIdentifier(out sessionId), "read session identifier");
            string endpointId;
            Check(device.GetId(out endpointId), "read endpoint identifier");
            observation.Matches.Add(ReadFormat(device, endpointId, sessionId, owner));
        }
        finally { Release(raw); }
    }

    private static Route ReadFormat(IMMDevice device, string endpointId, string sessionId, uint processId)
    {
        Guid clientId = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        object clientObject;
        Check(device.Activate(ref clientId, ClsctxAll, IntPtr.Zero, out clientObject), "open audio client");
        var client = (IAudioClient)clientObject;
        IntPtr format = IntPtr.Zero;
        try
        {
            Check(client.GetMixFormat(out format), "read endpoint format");
            ushort tag = (ushort)Marshal.ReadInt16(format, 0);
            ushort bitsPerSample = (ushort)Marshal.ReadInt16(format, 14);
            string sampleFormat = tag == 3 && bitsPerSample == 32 ? "f32" : "unknown";
            if (tag == 65534 && Marshal.ReadInt16(format, 16) >= 22)
            {
                var subtype = (Guid)Marshal.PtrToStructure(IntPtr.Add(format, 24), typeof(Guid));
                sampleFormat = subtype == new Guid("00000003-0000-0010-8000-00aa00389b71") && bitsPerSample == 32 ? "f32" : "unknown";
            }
            return new Route {
                EndpointId = endpointId, SessionId = sessionId, ProcessId = processId,
                Rate = Marshal.ReadInt32(format, 4), Channels = (ushort)Marshal.ReadInt16(format, 2), SampleFormat = sampleFormat
            };
        }
        finally
        {
            if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
            Release(client);
        }
    }

    private static void Check(int hresult, string stage)
    {
        if (hresult < 0) throw new InvalidOperationException(stage + " failed (0x" + hresult.ToString("X8", CultureInfo.InvariantCulture) + ")");
    }

    private static void Release(object value)
    {
        if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }

    private static string Escape(string value)
    {
        var builder = new StringBuilder();
        foreach (char character in value)
        {
            switch (character)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (character < 32) builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    else builder.Append(character);
                    break;
            }
        }
        return builder.ToString();
    }
}
