using System;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal sealed class ConnectionHelpView : UserControl
    {
        internal ConnectionHelpView(Action openRuntime, Action back)
        {
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            Dock = DockStyle.Top;
            BackColor = CompanionTheme.Background;
            var page = CompanionTheme.Stack(new Padding(30));
            var backLink = CompanionTheme.Link("← Back", back);
            backLink.Margin = new Padding(0, 0, 0, 20);
            CompanionTheme.Add(page, backLink);
            CompanionTheme.Add(page, CompanionTheme.Eyebrow("NO SAVED CONNECTION"));
            CompanionTheme.Add(page, CompanionTheme.Heading("Reconnect this computer from ABot"));
            CompanionTheme.Add(page, CompanionTheme.Copy(
                "This computer has no saved connection. ABot may still have its previous pairing.", true, false));
            var card = CompanionTheme.Card();
            CompanionTheme.Add(card, CompanionTheme.Step(1, "Return to ABot",
                "Open Home in your ABot browser tab."));
            CompanionTheme.Add(card, CompanionTheme.Step(2, "Choose Set up again",
                "Confirm removal of the old pairing. If no computer is paired, choose I already have it."));
            CompanionTheme.Add(card, CompanionTheme.Step(3, "Allow the new connection",
                "Continue with Open Companion, then review the ABot address before approving."));
            CompanionTheme.Add(page, card);
            if (openRuntime != null)
            {
                var actions = CompanionTheme.Actions();
                actions.Controls.Add(CompanionTheme.Button("Open ABot ↗", true, openRuntime));
                CompanionTheme.Add(page, actions);
            }
            Controls.Add(page);
        }
    }
}
