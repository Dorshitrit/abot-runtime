using System;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal sealed class PairingDialog : Form
    {
        internal PairingDialog(string runtimeUrl, string expiresAt, string existingRuntime, Action<string> openPolicyLink = null)
        {
            Text = "Connect this computer";
            FormBorderStyle = FormBorderStyle.Sizable;
            StartPosition = FormStartPosition.CenterParent;
            MinimizeBox = false;
            MaximizeBox = false;
            CompanionTheme.ApplyWindow(this);
            MinimumSize = new Size(560, 330);
            ClientSize = new Size(620, 350);
            var scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
            var content = CompanionTheme.Stack(new Padding(30));
            CompanionTheme.Add(content, CompanionTheme.Eyebrow("CONNECTION REQUEST"));
            CompanionTheme.Add(content, CompanionTheme.Heading("Allow ABot to connect?"));
            CompanionTheme.Add(content, CompanionTheme.Copy(
                "Confirm the address of the ABot runtime you opened in your browser.", true, false));
            var card = CompanionTheme.Card();
            var addressLabel = CompanionTheme.Eyebrow("ABot runtime");
            addressLabel.Margin = new Padding(0, 0, 0, 4);
            CompanionTheme.Add(card, addressLabel);
            CompanionTheme.Add(card, new RuntimeOriginBox(runtimeUrl));
            var local = CompanionTheme.Copy("Local connection on this computer", true, true);
            local.Margin = Padding.Empty;
            CompanionTheme.Add(card, local);
            CompanionTheme.Add(content, card);
            CompanionTheme.Add(content, Permission("•  Work with files and folders"));
            CompanionTheme.Add(content, Permission("•  Run commands and applications"));
            CompanionTheme.Add(content, Permission("•  Request screenshots and desktop actions"));
            CompanionTheme.Add(content, CompanionTheme.Copy(
                "Actions follow your ABot permission settings. You can disconnect this computer at any time.", true, true));
            CompanionTheme.Add(content, CompanionTheme.Copy(
                "The ABot runtime receives task data from this computer and may send it to your configured models and services, including file content, command output and screenshots. Disconnecting does not erase data already sent.", true, false));
            CompanionTheme.Add(content, CompanionTheme.Copy(ExpirationText(expiresAt, existingRuntime), true, true));
            var consent = new PairingConsentSection(openPolicyLink);
            CompanionTheme.Add(content, consent);
            var actions = CompanionTheme.Actions();
            var connect = CompanionTheme.Button("Allow connection", true, null);
            ApplyConsentState(connect, consent.IsAccepted);
            connect.DialogResult = DialogResult.OK;
            consent.AcceptanceChanged += delegate { ApplyConsentState(connect, consent.IsAccepted); };
            var cancel = CompanionTheme.Button("Cancel", false, null);
            cancel.DialogResult = DialogResult.Cancel;
            actions.Controls.Add(connect);
            actions.Controls.Add(cancel);
            CompanionTheme.Add(content, actions);
            scroll.Controls.Add(content);
            Controls.Add(scroll);
            AcceptButton = connect;
            CancelButton = cancel;
            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (DialogResult != DialogResult.OK) return;
                if (consent.IsAccepted) return;
                e.Cancel = true;
                DialogResult = DialogResult.None;
            };
            CompanionLayout.FitWindow(this, scroll, content, null);
        }

        private static void ApplyConsentState(Button connect, bool accepted)
        {
            connect.Enabled = accepted;
            connect.BackColor = accepted ? CompanionTheme.Accent : CompanionTheme.Panel;
            connect.FlatAppearance.BorderColor = accepted ? CompanionTheme.Accent : CompanionTheme.Line;
        }

        private static Label Permission(string value)
        {
            var label = CompanionTheme.Copy(value, false, false);
            label.Margin = new Padding(0, 0, 0, 10);
            return label;
        }

        private static string ExpirationText(string expiresAt, string existingRuntime)
        {
            if (!String.IsNullOrWhiteSpace(existingRuntime))
                return "Current connection: " + existingRuntime;
            DateTimeOffset expires;
            if (!DateTimeOffset.TryParse(expiresAt, CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind, out expires)) return "This invitation is temporary.";
            return "Invitation expires at " + expires.ToLocalTime().ToString("t") + ".";
        }
    }
}
