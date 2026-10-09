using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal sealed class ConnectionProgressView : TableLayoutPanel
    {
        internal ConnectionProgressView()
        {
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Dock = DockStyle.Top;
            ColumnCount = 1;
            ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Padding = new Padding(30);
            Margin = Padding.Empty;
            BackColor = CompanionTheme.Background;
            CompanionTheme.Add(this, CompanionTheme.Eyebrow("COMPUTER ACCESS"));
            CompanionTheme.Add(this, CompanionTheme.Heading("Connecting your computer…"));
            CompanionTheme.Add(this, CompanionTheme.Copy("This can take a few seconds.", true, false));
            CompanionTheme.Add(this, new ConnectionSpinner());
        }
    }

    internal sealed class ConnectionSpinner : Control
    {
        private readonly Timer animation = new Timer { Interval = 80 };
        private int angle;

        internal ConnectionSpinner()
        {
            Size = new Size(32, 32);
            Margin = Padding.Empty;
            AccessibleRole = AccessibleRole.ProgressBar;
            AccessibleName = "Connection in progress";
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer, true);
            animation.Tick += delegate { angle = (angle + 30) % 360; Invalidate(); };
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            animation.Start();
        }

        protected override void OnHandleDestroyed(EventArgs e)
        {
            animation.Stop();
            base.OnHandleDestroyed(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            float stroke = Math.Max(2, Width / 11f);
            var bounds = new RectangleF(stroke, stroke, Width - stroke * 2, Height - stroke * 2);
            using (var track = new Pen(CompanionTheme.Line, stroke)) e.Graphics.DrawEllipse(track, bounds);
            using (var arc = new Pen(CompanionTheme.Accent, stroke))
            {
                arc.StartCap = LineCap.Round;
                arc.EndCap = LineCap.Round;
                e.Graphics.DrawArc(arc, bounds, angle, 100);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) animation.Dispose();
            base.Dispose(disposing);
        }
    }
}
