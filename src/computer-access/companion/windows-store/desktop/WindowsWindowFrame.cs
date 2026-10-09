using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ABot.Companion.Desktop
{
    internal static class WindowsWindowFrame
    {
        private const int ImmersiveDarkMode = 20;
        private const int BorderColor = 34;
        private const int CaptionColor = 35;
        private const int CaptionTextColor = 36;
        private const int SystemDefaultColor = -1;

        [DllImport("dwmapi.dll", ExactSpelling = true)]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

        internal static void Attach(Form form)
        {
            bool active = false;
            EventHandler apply = delegate { ApplyCurrentFrame(form, active); };
            form.HandleCreated += apply;
            form.Activated += delegate { active = true; ApplyCurrentFrame(form, active); };
            form.Deactivate += delegate { active = false; ApplyCurrentFrame(form, active); };
            UserPreferenceChangedEventHandler preferences = delegate
            {
                if (!CanStyleFrame(form)) return;
                try { form.BeginInvoke(apply, form, EventArgs.Empty); }
                catch (InvalidOperationException) { }
            };
            SystemEvents.UserPreferenceChanged += preferences;
            form.Disposed += delegate { SystemEvents.UserPreferenceChanged -= preferences; };
            ApplyCurrentFrame(form, active);
        }

        private static bool CanStyleFrame(Form form)
        {
            if (form.IsDisposed) return false;
            return form.IsHandleCreated;
        }

        private static void ApplyCurrentFrame(Form form, bool active)
        {
            if (!CanStyleFrame(form)) return;
            ApplyToHandle(form.Handle, SystemInformation.HighContrast, active);
        }

        internal static void ApplyToHandle(IntPtr window, bool highContrast, bool active)
        {
            // Unsupported Windows versions retain their standard system frame.
            if (!TrySetNativeFrameAttribute(window, ImmersiveDarkMode, highContrast ? 0 : 1)) return;
            if (highContrast)
            {
                TrySetNativeFrameAttribute(window, BorderColor, SystemDefaultColor);
                TrySetNativeFrameAttribute(window, CaptionColor, SystemDefaultColor);
                TrySetNativeFrameAttribute(window, CaptionTextColor, SystemDefaultColor);
                return;
            }
            TrySetNativeFrameAttribute(window, BorderColor, ColorReference(CompanionTheme.Line));
            TrySetNativeFrameAttribute(window, CaptionColor, ColorReference(CompanionTheme.Panel));
            TrySetNativeFrameAttribute(window, CaptionTextColor,
                ColorReference(active ? CompanionTheme.Text : CompanionTheme.Muted));
        }

        private static int ColorReference(Color color)
        {
            return color.R | color.G << 8 | color.B << 16;
        }

        private static bool TrySetNativeFrameAttribute(IntPtr window, int attribute, int value)
        {
            try { return DwmSetWindowAttribute(window, attribute, ref value, sizeof(int)) >= 0; }
            catch (DllNotFoundException) { return false; }
            catch (EntryPointNotFoundException) { return false; }
        }
    }
}
