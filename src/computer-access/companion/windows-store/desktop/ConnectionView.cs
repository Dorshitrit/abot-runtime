using System;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal sealed class ConnectionView : UserControl
    {
        private readonly Label state;
        private readonly Label heading;
        private readonly Label explanation;
        private readonly Label origin;
        private readonly Label addressLabel;
        private readonly Button start;
        private readonly Button open;

        internal ConnectionView(Action openRuntime, Action startConnection, Action disconnect)
        {
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Dock = DockStyle.Top;
            BackColor = CompanionTheme.Background;
            var page = CompanionTheme.Stack(new Padding(30));
            state = CompanionTheme.Eyebrow("");
            state.ForeColor = CompanionTheme.Accent;
            CompanionTheme.Add(page, state);
            heading = CompanionTheme.Heading("");
            CompanionTheme.Add(page, heading);
            explanation = CompanionTheme.Copy("", true, false);
            CompanionTheme.Add(page, explanation);
            var card = CompanionTheme.Card();
            addressLabel = CompanionTheme.Eyebrow("");
            addressLabel.Margin = new Padding(0, 0, 0, 4);
            CompanionTheme.Add(card, addressLabel);
            origin = CompanionTheme.Copy("", false, false);
            origin.Font = CompanionTheme.StrongFont;
            origin.Margin = new Padding(0, 0, 0, 4);
            CompanionTheme.Add(card, origin);
            var local = CompanionTheme.Copy("Local connection on this computer", true, true);
            local.Margin = Padding.Empty;
            CompanionTheme.Add(card, local);
            CompanionTheme.Add(page, card);
            var actions = CompanionTheme.Actions();
            open = CompanionTheme.Button("Open ABot ↗", true, openRuntime);
            start = CompanionTheme.Button("Start connection", true, startConnection);
            actions.Controls.Add(open);
            actions.Controls.Add(start);
            actions.Controls.Add(CompanionTheme.Button("Disconnect", false, disconnect));
            CompanionTheme.Add(page, actions);
            var closing = CompanionTheme.Copy(
                "Closing this window keeps an active connection running. You can disconnect this computer at any time.", true, true);
            closing.Margin = new Padding(0, 18, 0, 0);
            CompanionTheme.Add(page, closing);
            Controls.Add(page);
        }

        internal void UpdateStatus(bool connected, string runtimeOrigin)
        {
            state.Text = connected ? "● CONNECTED" : "PAIRED · OFFLINE";
            state.ForeColor = connected ? CompanionTheme.Accent : CompanionTheme.Muted;
            heading.Text = connected ? "This computer is ready" : "Your connection is offline";
            explanation.Text = connected
                ? "You can continue working in ABot. Companion keeps the connection available in the background."
                : "Your pairing is saved. Check that ABot is running, then start the connection or refresh its status.";
            addressLabel.Text = connected ? "Connected to" : "Paired with";
            origin.Text = runtimeOrigin ?? "Saved ABot runtime";
            start.Visible = !connected;
            open.Enabled = runtimeOrigin != null;
        }
    }
}
