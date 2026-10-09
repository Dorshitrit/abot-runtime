using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal static class RoundedShape
    {
        internal static GraphicsPath Path(Rectangle bounds, int radius)
        {
            int diameter = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
            var path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal sealed class RoundedCard : TableLayoutPanel
    {
        internal RoundedCard()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? CompanionTheme.Background : Parent.BackColor);
            if (Width < 2 || Height < 2) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var shape = RoundedShape.Path(new Rectangle(0, 0, Width - 1, Height - 1), 8))
            using (var fill = new SolidBrush(CompanionTheme.Panel))
            using (var border = new Pen(CompanionTheme.Line))
            {
                e.Graphics.FillPath(fill, shape);
                e.Graphics.DrawPath(border, shape);
            }
        }
    }

    internal sealed class RoundedButton : Button
    {
        private bool hover;
        private bool pressed;

        internal RoundedButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
        }

        public override Size GetPreferredSize(Size proposedSize)
        {
            Size text = TextRenderer.MeasureText(Text, Font, Size.Empty,
                TextFormatFlags.SingleLine | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            return new Size(text.Width + Padding.Horizontal + 2, Math.Max(MinimumSize.Height, text.Height + Padding.Vertical));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? CompanionTheme.Background : Parent.BackColor);
            if (Width < 2 || Height < 2) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fillColor = BackColor;
            if (hover && Enabled) fillColor = FlatAppearance.MouseOverBackColor;
            if (pressed && Enabled) fillColor = ControlPaint.Dark(fillColor, 0.08f);
            using (var shape = RoundedShape.Path(new Rectangle(0, 0, Width - 1, Height - 1), 6))
            using (var fill = new SolidBrush(fillColor))
            using (var border = new Pen(FlatAppearance.BorderColor))
            {
                e.Graphics.FillPath(fill, shape);
                e.Graphics.DrawPath(border, shape);
            }
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle,
                Enabled ? ForeColor : CompanionTheme.Muted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
                TextFormatFlags.SingleLine | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            if (Focused && ShowFocusCues)
                ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -5, -5), ForeColor, BackColor);
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { pressed = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    }
}
