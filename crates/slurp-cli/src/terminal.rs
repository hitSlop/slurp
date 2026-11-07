//! Interactive terminal rendering, separate from workspace operations.
use anyhow::{Result, bail};
use slurp_app::error::{ErrorCode, Failure};
use std::io::{self, IsTerminal, Write};

pub struct Terminal {
    pub interactive: bool,
    fancy: bool,
    credentials_announced: std::cell::Cell<bool>,
}
impl Terminal {
    pub fn credentials(&self) -> Result<()> {
        if self.interactive && !self.credentials_announced.replace(true) {
            let message = match slurp_client::storage::selected()? {
                slurp_client::storage::Store::File => format!("Slurp saves your Worker connection and SDK keys in {} with owner-only permissions. Saved credentials work without Keychain prompts.", slurp_client::config::home()?.join("credentials.json").display()),
                slurp_client::storage::Store::Keychain if cfg!(target_os = "macos") => "Keychain storage is enabled. macOS may ask you to allow access to dev.slurp.service.".into(),
                slurp_client::storage::Store::Keychain => "Native credential storage is enabled in your system settings.".into(),
            };
            self.note("Saved credentials", &message)?;
        }
        Ok(())
    }
    pub fn heading(&self, message: &str) -> Result<()> {
        if self.fancy {
            cliclack::intro(message)?;
        } else if self.interactive {
            eprintln!("{message}");
        }
        Ok(())
    }
    pub fn welcome(&self, first: bool) -> Result<()> {
        if !self.interactive {
            return Ok(());
        }
        if self.fancy {
            let logo = r"   _____ __
  / ___// /_  ___________
  \__ \/ / / / / ___/ __ \
 ___/ / / /_/ / /  / /_/ /
/____/_/\__,_/_/  / .___/
                /_/";
            if std::env::var_os("NO_COLOR").is_none() {
                eprintln!("\x1b[31m{logo}\x1b[0m\n");
            } else {
                eprintln!("{logo}\n");
            }
            cliclack::intro("Bring your events home.")?;
        } else {
            eprintln!("Slurp — Bring your events home.");
        }
        if first {
            self.note("Welcome to Slurp", "Slurp lets your agents track what they need, pull events into local DuckDB, and figure out how to improve your product—at a fraction of the cost of traditional analytics platforms.\n\nYour app -> Slurp -> Local DuckDB -> Your agent\n\nPrepare this computer:\n  1. Choose where your event library lives\n  2. Find or install DuckDB\n  3. Sign in to Slurp\n\nAfter setup, run slurp init inside your app's folder.")?;
        } else {
            self.note("Machine setup", "Review your storage and DuckDB preferences. Existing projects keep their saved locations.")?;
        }
        Ok(())
    }
    pub fn success(&self, message: &str) -> Result<()> {
        if self.fancy {
            cliclack::outro(message)?;
        } else if self.interactive {
            eprintln!("{message}");
        }
        Ok(())
    }
    pub fn new(machine_output: bool) -> Self {
        let interactive = !machine_output
            && io::stdin().is_terminal()
            && io::stdout().is_terminal()
            && io::stderr().is_terminal();
        let fancy = interactive
            && console::Term::stderr().size().1 >= 40
            && std::env::var("TERM").is_ok_and(|v| !v.is_empty() && v != "dumb");
        Self {
            interactive,
            fancy,
            credentials_announced: std::cell::Cell::new(false),
        }
    }
    pub fn intro(&self) -> Result<()> {
        if self.fancy {
            cliclack::intro("Slurp · Connect this app")?;
        } else if self.interactive {
            eprintln!("Slurp · Connect this app");
        }
        Ok(())
    }
    pub fn note(&self, title: &str, message: &str) -> Result<()> {
        if self.fancy {
            cliclack::note(title, message)?;
        } else if self.interactive {
            eprintln!("{title}\n{message}");
        }
        Ok(())
    }
    pub fn input(
        &self,
        label: &str,
        default: &str,
        validate: impl Fn(&str) -> std::result::Result<(), String> + 'static,
    ) -> Result<String> {
        if self.fancy {
            return interrupted(
                cliclack::input(label)
                    .required(false)
                    .default_input(default)
                    .validate(move |s: &String| validate(s.trim()))
                    .interact::<String>(),
            )
            .map(|v| v.trim().to_owned());
        }
        loop {
            eprint!(
                "{label}{} ",
                if default.is_empty() {
                    String::new()
                } else {
                    format!(" [{default}]")
                }
            );
            let answer = line()?;
            let answer = if answer.is_empty() {
                default.to_owned()
            } else {
                answer
            };
            match validate(&answer) {
                Ok(()) => return Ok(answer),
                Err(error) => eprintln!("{error}"),
            }
        }
    }
    /// Ask for a secret without echoing it where the terminal supports that.
    pub fn secret(&self, label: &str) -> Result<String> {
        if self.fancy {
            return interrupted(cliclack::password(label).mask('•').interact())
                .map(|v| v.trim().to_owned());
        }
        eprint!("{label} (input is visible): ");
        line()
    }
    pub fn confirm(&self, label: &str, initial: bool) -> Result<bool> {
        if self.fancy {
            return interrupted(cliclack::confirm(label).initial_value(initial).interact());
        }
        loop {
            eprint!("{label} {} ", if initial { "[Y/n]" } else { "[y/N]" });
            match line()?.to_ascii_lowercase().as_str() {
                "" => return Ok(initial),
                "y" | "yes" => return Ok(true),
                "n" | "no" => return Ok(false),
                _ => eprintln!("Enter yes or no."),
            }
        }
    }
    pub fn select(
        &self,
        label: &str,
        items: &[(String, String, String)],
        initial: &str,
    ) -> Result<String> {
        if self.fancy {
            let mut select = cliclack::select(label).initial_value(initial.to_owned());
            for (value, label, hint) in items {
                select = select.item(value.clone(), label, hint);
            }
            return interrupted(select.interact());
        }
        loop {
            eprintln!("{label}");
            for (index, (value, label, hint)) in items.iter().enumerate() {
                eprintln!(
                    "  {}. {} — {}{}",
                    index + 1,
                    label,
                    hint,
                    if value == initial { " [default]" } else { "" }
                );
            }
            eprint!("Choose a number: ");
            let answer = line()?;
            if answer.is_empty() {
                return Ok(initial.to_owned());
            }
            if let Ok(index) = answer.parse::<usize>()
                && let Some(item) = index.checked_sub(1).and_then(|i| items.get(i))
            {
                return Ok(item.0.clone());
            }
            eprintln!("Choose one of the listed numbers.");
        }
    }
}
fn interrupted<T>(result: io::Result<T>) -> Result<T> {
    match result {
        Err(error) if error.kind() == io::ErrorKind::Interrupted => bail!(Failure::new(
            ErrorCode::Cancelled,
            "setup cancelled; no workspace changes applied"
        )),
        result => Ok(result?),
    }
}
fn line() -> Result<String> {
    io::stderr().flush()?;
    let mut text = String::new();
    if io::stdin().read_line(&mut text)? == 0 {
        bail!(Failure::new(
            ErrorCode::Cancelled,
            "setup cancelled: input closed"
        ));
    }
    Ok(text.trim().to_owned())
}
