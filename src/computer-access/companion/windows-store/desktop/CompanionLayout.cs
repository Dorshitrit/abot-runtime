using System;
using System.Drawing;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal static class CompanionLayout
    {
        internal static void FitWindow(Form window, Control viewport, Control page, Control footer)
        {
            if (page == null) return;
            viewport.PerformLayout();
            page.PerformLayout();
            int footerHeight = footer == null ? 0 : footer.Height;
            int borderHeight = window.Height - window.ClientSize.Height;
            int maximum = Math.Max(300, Screen.FromControl(window).WorkingArea.Height - borderHeight - 64);
            int contentHeight = Math.Max(300, page.Height + footerHeight);
            window.ClientSize = new Size(window.ClientSize.Width, Math.Min(contentHeight, maximum));
        }
    }
}
