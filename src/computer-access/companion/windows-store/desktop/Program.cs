using System;
using System.Windows.Forms;

namespace ABot.Companion.Desktop
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                if (IsBackgroundActivation(args))
                {
                    CompanionProcess.StartBackground();
                    return;
                }
                string activation = CompanionActivation.Read(args);
                Application.Run(new CompanionWindow(activation));
            }
            catch (Exception)
            {
                MessageBox.Show("ABot AI Companion could not start. Reopen the app or repair it in Windows Settings.",
                    "ABot AI Companion", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static bool IsBackgroundActivation(string[] args)
        {
            return args.Length == 1 && args[0] == "--background";
        }

    }
}
