using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal sealed class CompanionText : Label
    {
        internal int LineHeight { get; set; }

        internal CompanionText()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            LineHeight = 21;
        }

        public override Size GetPreferredSize(Size proposedSize)
        {
            int width = proposedSize.Width;
            if (width <= 1) width = Int32.MaxValue;
            var lines = Wrap(Text, Font, width);
            int naturalWidth = 0;
            foreach (string line in lines) naturalWidth = Math.Max(naturalWidth, Measure(line, Font));
            return new Size(Math.Min(width, naturalWidth), lines.Count * LineHeight);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var lines = Wrap(Text, Font, ClientSize.Width);
            int top = 0;
            foreach (string line in lines)
            {
                TextRenderer.DrawText(e.Graphics, line, Font,
                    new Rectangle(0, top, ClientSize.Width, LineHeight), ForeColor,
                    TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter);
                top += LineHeight;
            }
        }

        internal static List<string> Wrap(string value, Font font, int width)
        {
            var result = new List<string>();
            width = Math.Max(width, 1);
            foreach (string paragraph in (value ?? "").Replace("\r", "").Split('\n'))
            {
                string current = "";
                foreach (string word in paragraph.Split(' '))
                {
                    string candidate = current.Length == 0 ? word : current + " " + word;
                    if (Measure(candidate, font) <= width) { current = candidate; continue; }
                    if (current.Length > 0) result.Add(current);
                    current = "";
                    var elements = StringInfo.GetTextElementEnumerator(word);
                    while (elements.MoveNext())
                    {
                        string element = elements.GetTextElement();
                        if (current.Length > 0 && Measure(current + element, font) > width)
                        {
                            result.Add(current);
                            current = "";
                        }
                        current += element;
                    }
                }
                result.Add(current);
            }
            return result;
        }

        private static int Measure(string text, Font font)
        {
            return TextRenderer.MeasureText(text, font, Size.Empty,
                TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine).Width;
        }
    }

    internal sealed class RuntimeOriginBox : TextBox
    {
        internal RuntimeOriginBox(string origin)
        {
            Text = origin;
            ReadOnly = true;
            Multiline = true;
            WordWrap = true;
            ScrollBars = ScrollBars.None;
            BorderStyle = BorderStyle.None;
            BackColor = CompanionTheme.Panel;
            ForeColor = CompanionTheme.Text;
            Font = CompanionTheme.StrongFont;
            Dock = DockStyle.Top;
            Margin = new Padding(0, 0, 0, 4);
            AccessibleName = "ABot runtime address";
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            int desired = Math.Max(21, CompanionText.Wrap(Text, Font, Math.Max(1, Width - 4)).Count * 21 + 2);
            if (Height != desired) Height = desired;
        }
    }
}
