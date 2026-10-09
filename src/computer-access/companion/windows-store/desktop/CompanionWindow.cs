using System;
using System.Diagnostics;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal sealed class CompanionWindow : Form
    {
        private const string SetupGuideUrl = "https://github.com/Dorshitrit/abot-runtime/blob/main/docs/installation.md#install-the-local-application";
        private readonly Panel content = new Panel();
        private readonly Label feedback = CompanionTheme.Copy("", true, true);
        private TableLayoutPanel footer;
        private LinkLabel refresh;
        private LinkLabel startup;
        private ConnectionView connectionView;
        private string runtimeOrigin;
        private bool paired;
        private bool connected;
        private bool busy;
        private readonly string activation;

        internal CompanionWindow(string activation)
        {
            this.activation = activation;
            Text = "ABot AI Companion";
            StartPosition = FormStartPosition.CenterScreen;
            CompanionTheme.ApplyWindow(this);
            MinimumSize = new Size(560, 330);
            ClientSize = new Size(620, 350);
            BuildContents();
            ShowWelcome();
            Shown += async delegate { await Initialize(); };
            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (!busy) return;
                e.Cancel = true;
            };
        }

        private void BuildContents()
        {
            var frame = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
            frame.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            frame.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            frame.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            content.Dock = DockStyle.Fill;
            content.AutoScroll = true;
            content.Margin = Padding.Empty;
            frame.Controls.Add(content, 0, 0);
            footer = CompanionTheme.Stack(new Padding(24, 14, 24, 12));
            footer.BackColor = CompanionTheme.Panel;
            var links = CompanionTheme.Actions();
            links.Margin = Padding.Empty;
            var updates = CompanionTheme.Copy("Updates through Microsoft Store", true, true);
            updates.Margin = new Padding(0, 0, 20, 8);
            links.Controls.Add(updates);
            refresh = CompanionTheme.Link("Refresh", async delegate { await Perform(RefreshStatus); });
            startup = CompanionTheme.Link("Startup settings", async delegate { await Perform(OpenStartupSettings); });
            links.Controls.Add(refresh);
            links.Controls.Add(startup);
            CompanionTheme.Add(footer, links);
            feedback.Margin = new Padding(0, 6, 0, 0);
            CompanionTheme.Add(footer, feedback);
            frame.Controls.Add(footer, 0, 1);
            Controls.Add(frame);
        }

        private void ShowWelcome()
        {
            ShowPage(WelcomeViews.Welcome(ShowSetup, ShowConnect));
        }

        private void ShowSetup()
        {
            ShowPage(WelcomeViews.Setup(ShowWelcome,
                async delegate { await Perform(OpenSetupGuide); }, ShowConnect));
        }

        private void ShowConnect()
        {
            ShowPage(WelcomeViews.Connect(ShowWelcome));
        }

        private void ShowConnectionHelp()
        {
            Action openRuntime = null;
            if (runtimeOrigin != null) openRuntime = async delegate { await Perform(OpenRuntime); };
            ShowPage(new ConnectionHelpView(openRuntime, ShowWelcome));
        }

        private void ShowConnectionEntry()
        {
            if (paired)
            {
                ShowConnection();
                return;
            }
            ShowConnectionHelp();
        }

        private void ShowPage(Control page)
        {
            content.SuspendLayout();
            while (content.Controls.Count > 0) content.Controls[0].Dispose();
            connectionView = page as ConnectionView;
            content.Controls.Add(page);
            content.AutoScrollPosition = Point.Empty;
            content.ResumeLayout(true);
            SetFeedback("");
            CompanionLayout.FitWindow(this, content, page, footer);
        }

        private void ShowConnection()
        {
            if (connectionView == null)
                ShowPage(new ConnectionView(
                    async delegate { await Perform(OpenRuntime); },
                    async delegate { await Perform(StartConnection); },
                    async delegate { await Perform(Disconnect); }));
            connectionView.UpdateStatus(connected, runtimeOrigin);
            CompanionLayout.FitWindow(this, content, connectionView, footer);
        }

        private async Task Initialize()
        {
            await Perform(async delegate
            {
                await RefreshStatus();
                if (activation == null) return;
                if (CompanionActivation.IsOpenLink(activation))
                {
                    ShowConnectionEntry();
                    return;
                }
                if (activation.StartsWith("abot:", StringComparison.OrdinalIgnoreCase))
                {
                    await CompanionProcess.OpenPluginLink(activation);
                    return;
                }
                await ConnectInvitation();
            });
        }

        private async Task ConnectInvitation()
        {
            var invitation = await CompanionProcess.ReadJson("inspect-link", activation);
            string origin = RuntimeAddress.BrowserOrigin(CompanionProcess.ReadText(invitation, "runtimeUrl"));
            if (origin == null) throw new InvalidOperationException("invitation_origin_invalid");
            string existing = RuntimeAddress.BrowserOrigin(CompanionProcess.ReadText(invitation, "existingRuntimeUrl"));
            using (var consent = new PairingDialog(origin,
                CompanionProcess.ReadText(invitation, "expiresAt"), existing))
            {
                if (consent.ShowDialog(this) != DialogResult.OK) return;
            }
            var progress = new ConnectionProgressView();
            ShowPage(progress);
            content.Refresh();
            try
            {
                await CompanionProcess.Setup(activation);
                await RefreshStatus();
            }
            finally { RestoreConnectionPage(progress); }
        }

        private void RestoreConnectionPage(ConnectionProgressView progress)
        {
            if (progress.IsDisposed) return;
            if (paired)
            {
                ShowConnection();
                return;
            }
            ShowWelcome();
        }

        private async Task RefreshStatus()
        {
            SetFeedback("Checking connection...");
            var value = await CompanionProcess.ReadJson("host status", null);
            paired = CompanionProcess.ReadBoolean(value, "paired");
            connected = CompanionProcess.ReadBoolean(value, "connected");
            // Keep the last verified origin only in this window, for the reconnect help link.
            if (paired) runtimeOrigin = RuntimeAddress.BrowserOrigin(CompanionProcess.ReadText(value, "url"));
            if (paired) ShowConnection();
            if (!paired && connectionView != null) ShowWelcome();
            SetFeedback("");
        }

        private async Task StartConnection()
        {
            CompanionProcess.StartBackground();
            SetFeedback("Starting connection...");
            for (int attempt = 0; attempt < 5; attempt++)
            {
                await Task.Delay(1000);
                await RefreshStatus();
                if (connected) return;
            }
            SetFeedback("Connection has not become ready. Check that ABot is running, then refresh.");
        }

        private async Task Disconnect()
        {
            var answer = MessageBox.Show(this,
                "Disconnect this computer and remove its local connection? ABot keeps its paired-computer record. To reconnect, open Home in ABot and choose Set up again.",
                "Disconnect computer", MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                MessageBoxDefaultButton.Button2);
            if (answer != DialogResult.Yes) return;
            SetFeedback("Disconnecting...");
            await CompanionProcess.Disconnect();
            await RefreshStatus();
            ShowConnectionHelp();
        }

        private Task OpenRuntime()
        {
            if (runtimeOrigin == null) throw new InvalidOperationException("runtime_origin_unavailable");
            return OpenBrowser(runtimeOrigin);
        }

        private Task OpenSetupGuide() { return OpenBrowser(SetupGuideUrl); }
        private Task OpenStartupSettings() { return OpenBrowser("ms-settings:startupapps"); }

        private static Task OpenBrowser(string address)
        {
            Process.Start(new ProcessStartInfo { FileName = address, UseShellExecute = true });
            return Task.FromResult(0);
        }

        private void SetFeedback(string value)
        {
            feedback.Text = value;
            feedback.Visible = !String.IsNullOrEmpty(value);
        }

        private async Task Perform(Func<Task> action)
        {
            if (busy) return;
            busy = true;
            ApplyEnabledState();
            SetFeedback("");
            try { await action(); }
            catch (MissingLocalConnectionException)
            {
                paired = false;
                connected = false;
                ShowConnectionHelp();
            }
            catch (Exception)
            {
                SetFeedback("The action could not be completed.");
                MessageBox.Show(this,
                    "Companion could not complete this action. Check that ABot is available. For pairing, generate a new invitation from Connect computer in ABot.",
                    "ABot AI Companion", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally
            {
                busy = false;
                ApplyEnabledState();
            }
        }

        private void ApplyEnabledState()
        {
            content.Enabled = !busy;
            refresh.Enabled = !busy;
            startup.Enabled = !busy;
        }
    }
}
