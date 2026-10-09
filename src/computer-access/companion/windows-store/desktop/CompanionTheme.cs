using System;
using System.Drawing;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal static class CompanionTheme
    {
        internal static readonly Color Background = Color.FromArgb(23, 28, 33);
        internal static readonly Color Panel = Color.FromArgb(34, 42, 49);
        internal static readonly Color Text = Color.FromArgb(237, 245, 247);
        internal static readonly Color Muted = Color.FromArgb(176, 192, 202);
        internal static readonly Color Line = Color.FromArgb(56, 67, 76);
        internal static readonly Color Accent = Color.FromArgb(64, 225, 178);
        internal static readonly Font BodyFont = new Font("Segoe UI", 14, FontStyle.Regular, GraphicsUnit.Pixel);
        internal static readonly Font SmallFont = new Font("Segoe UI", 12, FontStyle.Regular, GraphicsUnit.Pixel);
        internal static readonly Font HeadingFont = new Font("Segoe UI Semibold", 24, FontStyle.Regular, GraphicsUnit.Pixel);
        internal static readonly Font StrongFont = new Font("Segoe UI Semibold", 14, FontStyle.Regular, GraphicsUnit.Pixel);

        internal static TableLayoutPanel Stack(Padding padding)
        {
            var stack = new TableLayoutPanel
            {
                AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Dock = DockStyle.Top, ColumnCount = 1, Padding = padding,
                BackColor = Background, Margin = Padding.Empty
            };
            stack.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            return stack;
        }

        internal static void Add(TableLayoutPanel stack, Control control)
        {
            int row = stack.RowCount++;
            stack.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            stack.Controls.Add(control, 0, row);
        }

        internal static Label Copy(string value, bool muted, bool small)
        {
            return new CompanionText
            {
                Text = value, AutoSize = true, Dock = DockStyle.Fill,
                LineHeight = small ? 18 : 21,
                ForeColor = muted ? Muted : Text,
                Font = small ? SmallFont : BodyFont,
                Margin = new Padding(0, 0, 0, small ? 23 : 22), UseMnemonic = false
            };
        }

        internal static Label Heading(string value)
        {
            var label = Copy(value, false, false);
            label.Font = HeadingFont;
            ((CompanionText)label).LineHeight = 31;
            label.Margin = new Padding(0, 0, 0, 9);
            return label;
        }

        internal static Label Eyebrow(string value)
        {
            var label = Copy(value, true, true);
            label.Margin = new Padding(0, 0, 0, 10);
            return label;
        }

        internal static TableLayoutPanel Card()
        {
            var card = new RoundedCard
            {
                AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Dock = DockStyle.Top, ColumnCount = 1, Padding = new Padding(18, 16, 18, 16),
                BackColor = Panel, Margin = new Padding(0, 0, 0, 20)
            };
            card.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            return card;
        }

        internal static FlowLayoutPanel Actions()
        {
            return new FlowLayoutPanel
            {
                AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                Dock = DockStyle.Fill, WrapContents = true,
                Margin = Padding.Empty
            };
        }

        internal static Button Button(string label, bool primary, Action action)
        {
            var button = new RoundedButton
            {
                Text = label, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                MinimumSize = new Size(0, 38), Padding = new Padding(17, 8, 17, 8),
                Margin = new Padding(0, 0, 9, 0), Font = primary ? StrongFont : BodyFont,
                BackColor = primary ? Accent : Panel,
                ForeColor = primary ? Color.FromArgb(9, 36, 29) : Text,
                FlatStyle = FlatStyle.Flat, UseVisualStyleBackColor = false,
                Cursor = Cursors.Hand
            };
            button.FlatAppearance.BorderColor = primary ? Accent : Line;
            button.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(89, 236, 193) : Line;
            button.Click += delegate { if (action != null) action(); };
            return button;
        }

        internal static LinkLabel Link(string label, Action action)
        {
            var link = new LinkLabel
            {
                Text = label, AutoSize = true, Font = SmallFont,
                LinkColor = Muted, ActiveLinkColor = Accent, VisitedLinkColor = Muted,
                Margin = new Padding(0, 0, 16, 0), LinkBehavior = LinkBehavior.HoverUnderline
            };
            link.LinkClicked += delegate { action(); };
            return link;
        }

        internal static Control Step(int number, string title, string detail)
        {
            var row = new TableLayoutPanel
            {
                AutoSize = true, Dock = DockStyle.Top, ColumnCount = 2,
                Margin = new Padding(0, 7, 0, 7), BackColor = Color.Transparent
            };
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 38));
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            var marker = Copy(number.ToString(), true, false);
            marker.Font = StrongFont;
            marker.Margin = new Padding(0, 0, 8, 0);
            row.Controls.Add(marker, 0, 0);
            row.SetRowSpan(marker, 2);
            var name = Copy(title, false, false);
            name.Font = StrongFont;
            name.Margin = Padding.Empty;
            row.Controls.Add(name, 1, 0);
            var description = Copy(detail, true, true);
            description.Margin = Padding.Empty;
            row.Controls.Add(description, 1, 1);
            return row;
        }

        internal static void ApplyWindow(Form form)
        {
            form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            form.AutoScaleDimensions = new SizeF(96, 96);
            form.AutoScaleMode = AutoScaleMode.Dpi;
            form.BackColor = Background;
            form.ForeColor = Text;
            form.Font = BodyFont;
            WindowsWindowFrame.Attach(form);
        }
    }
}
