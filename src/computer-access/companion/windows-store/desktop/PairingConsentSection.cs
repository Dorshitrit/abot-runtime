using System;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal sealed class PairingConsentSection : TableLayoutPanel
    {
        private const string TermsUrl = "https://abot-ai.com/terms/#software";
        private const string PrivacyUrl = "https://abot-ai.com/privacy/#software";
        private const string ConsentText = "I allow computer access and data sharing as described above, agree to the Terms, and acknowledge that I have read the Privacy Policy.";
        private readonly CheckBox agreement;
        private readonly Action<string> openPolicyLink;

        internal event EventHandler AcceptanceChanged;
        internal bool IsAccepted { get { return agreement.Checked; } }

        internal PairingConsentSection(Action<string> openPolicyLink = null)
        {
            this.openPolicyLink = openPolicyLink ?? OpenInBrowser;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Dock = DockStyle.Top;
            ColumnCount = 1;
            ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            BackColor = CompanionTheme.Background;
            Margin = new Padding(0, 0, 0, 22);
            agreement = new CheckBox
            {
                AccessibleName = ConsentText,
                Checked = false, AutoSize = true, Anchor = AnchorStyles.Top | AnchorStyles.Left,
                Font = CompanionTheme.BodyFont, ForeColor = CompanionTheme.Text,
                BackColor = CompanionTheme.Background, UseVisualStyleBackColor = false,
                TextAlign = ContentAlignment.TopLeft, CheckAlign = ContentAlignment.TopLeft,
                Margin = new Padding(0, 3, 0, 0)
            };
            agreement.CheckedChanged += delegate
            {
                var changed = AcceptanceChanged;
                if (changed != null) changed(this, EventArgs.Empty);
            };
            var statement = CompanionTheme.Copy(ConsentText, false, false);
            statement.Margin = Padding.Empty;
            statement.Cursor = Cursors.Hand;
            statement.Click += delegate { agreement.Checked = !agreement.Checked; };
            var agreementRow = new TableLayoutPanel
            {
                AutoSize = true, Dock = DockStyle.Top, ColumnCount = 2,
                BackColor = CompanionTheme.Background, Margin = Padding.Empty
            };
            agreementRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 24));
            agreementRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            agreementRow.Controls.Add(agreement, 0, 0);
            agreementRow.Controls.Add(statement, 1, 0);
            CompanionTheme.Add(this, agreementRow);
            var links = CompanionTheme.Actions();
            links.Margin = new Padding(24, 9, 0, 0);
            links.Controls.Add(CompanionTheme.Link("Terms", delegate { OpenPolicy(TermsUrl); }));
            links.Controls.Add(CompanionTheme.Link("Privacy Policy", delegate { OpenPolicy(PrivacyUrl); }));
            CompanionTheme.Add(this, links);
        }

        private void OpenPolicy(string address)
        {
            try { openPolicyLink(address); }
            catch (Exception)
            {
                MessageBox.Show(FindForm(), "The page could not be opened. You can read it at " + address,
                    "ABot AI Companion", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private static void OpenInBrowser(string address)
        {
            Process.Start(new ProcessStartInfo { FileName = address, UseShellExecute = true });
        }
    }
}
