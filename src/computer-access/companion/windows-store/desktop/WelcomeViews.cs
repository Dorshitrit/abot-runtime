using System;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal static class WelcomeViews
    {
        internal static Control Welcome(Action setup, Action connect)
        {
            var page = CompanionTheme.Stack(new Padding(30));
            CompanionTheme.Add(page, CompanionTheme.Eyebrow("WELCOME TO ABOT"));
            CompanionTheme.Add(page, CompanionTheme.Heading("Your AI assistant, ready to do more"));
            CompanionTheme.Add(page, CompanionTheme.Copy(
                "Research a topic, build a project, organize files or work with apps — with an AI assistant that can take action on your computer.", true, false));
            var card = CompanionTheme.Card();
            var title = CompanionTheme.Copy("What does Companion do?", false, false);
            title.Font = CompanionTheme.StrongFont;
            title.Margin = new Padding(0, 0, 0, 8);
            CompanionTheme.Add(card, title);
            var description = CompanionTheme.Copy(
                "This app connects your Windows computer to ABot. You give ABot a task; Companion provides access to the computer tools needed to carry it out, according to your permission settings.", true, false);
            description.Margin = Padding.Empty;
            CompanionTheme.Add(card, description);
            CompanionTheme.Add(page, card);
            CompanionTheme.Add(page, CompanionTheme.Copy(
                "To get started, you also need ABot running with an AI model configured. Companion is the connection app; your conversations and tasks happen in ABot.", true, true));
            var actions = CompanionTheme.Actions();
            actions.Controls.Add(CompanionTheme.Button("New to ABot? Start here", true, setup));
            actions.Controls.Add(CompanionTheme.Button("I already use ABot", false, connect));
            CompanionTheme.Add(page, actions);
            return page;
        }

        internal static Control Setup(Action back, Action guide, Action ready)
        {
            var page = CompanionTheme.Stack(new Padding(30));
            CompanionTheme.Add(page, Back(back));
            CompanionTheme.Add(page, CompanionTheme.Eyebrow("GET STARTED"));
            CompanionTheme.Add(page, CompanionTheme.Heading("Set up ABot, then connect"));
            CompanionTheme.Add(page, CompanionTheme.Copy(
                "Companion is installed. Here is how to complete your setup.", true, false));
            CompanionTheme.Add(page, CompanionTheme.Step(1, "Install and start ABot",
                "Follow the setup guide to run ABot on your computer."));
            CompanionTheme.Add(page, CompanionTheme.Step(2, "Choose your AI model",
                "ABot supports cloud providers and local models. Provider fees may apply."));
            CompanionTheme.Add(page, CompanionTheme.Step(3, "Connect this computer",
                "In ABot, open Home → Computer access."));
            var actions = CompanionTheme.Actions();
            actions.Margin = new Padding(0, 24, 0, 0);
            actions.Controls.Add(CompanionTheme.Button("Open setup guide ↗", true, guide));
            actions.Controls.Add(CompanionTheme.Button("ABot is ready", false, ready));
            CompanionTheme.Add(page, actions);
            return page;
        }

        internal static Control Connect(Action back)
        {
            var page = CompanionTheme.Stack(new Padding(30));
            CompanionTheme.Add(page, Back(back));
            CompanionTheme.Add(page, CompanionTheme.Eyebrow("COMPUTER ACCESS"));
            CompanionTheme.Add(page, CompanionTheme.Heading("Connect this computer to ABot"));
            CompanionTheme.Add(page, CompanionTheme.Copy(
                "Companion lets ABot work with files, commands and desktop tools on this computer.", true, false));
            var card = CompanionTheme.Card();
            CompanionTheme.Add(card, CompanionTheme.Step(1, "Open ABot in your browser",
                "Go to Home → Computer access."));
            CompanionTheme.Add(card, CompanionTheme.Step(2, "Select Connect computer",
                "Your browser will open this app."));
            CompanionTheme.Add(card, CompanionTheme.Step(3, "Review and approve the connection",
                "Check the ABot address before connecting."));
            CompanionTheme.Add(page, card);
            CompanionTheme.Add(page, CompanionTheme.Copy(
                "Not connected to an ABot runtime yet.", true, true));
            return page;
        }

        private static Control Back(Action action)
        {
            var link = CompanionTheme.Link("← Back", action);
            link.Margin = new Padding(0, 0, 0, 20);
            return link;
        }
    }
}
