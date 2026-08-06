//! What `nport` refuses **before it touches the network**, driven through the real binary.
//!
//! These exist because the unit tests next to each rule cannot see the wiring.
//! `nport_contract::subdomain` is thoroughly tested and was still reachable from nowhere for the
//! whole of Phase 2 — the mirror did not exist, and the file that would have called it said it did
//! (`docs/ROADMAP.md`, defect 34). `docs/ROADMAP.md`'s defect 25 records the same trap one layer
//! down: a test of `markdown_files` passed with the call site reverted, because it never asserted
//! anything *called* it. So the subject here is the binary, not a function.
//!
//! No control plane is running, and that is the point. Every case below must fail without one; a case
//! that hangs or reports a network problem is the ordering being wrong.

use std::path::Path;
use std::process::Command;

/// The binary cargo just built, so this cannot test a stale one.
const NPORT: &str = env!("CARGO_BIN_EXE_nport");

/// A run with the developer's own `~/.nport/config.toml` kept out of it.
///
/// `NPORT_HOME` is the seam `pnpm smoke` uses too. Without it a real config supplying a `subdomain`
/// or a `port` would change what these assert, which is the "harness shares state with its
/// environment" failure `docs/ROADMAP.md` records against the smoke tests.
fn nport(args: &[&str]) -> std::process::Output {
    let empty = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/empty-home");
    Command::new(NPORT)
        .args(args)
        .env("NPORT_HOME", &empty)
        .env("NPORT_LANG", "en")
        .output()
        .expect("the binary runs")
}

#[test]
fn an_illegal_subdomain_is_refused_without_a_request() {
    // Port 1 has nothing listening on it either, which is what makes this an ordering assertion:
    // there are two reasons to fail here and only one of them is the user's actual mistake.
    let output = nport(&["1", "-s", "my_app"]);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(!output.status.success(), "should have exited non-zero");
    assert!(
        stderr.contains("INVALID_SUBDOMAIN"),
        "expected the registry code: {stderr}"
    );
    // The contract's own spelling of the reason, so this line matches what the server would have
    // sent in `details.reason` for the same name.
    assert!(
        stderr.contains("invalid-characters"),
        "expected the specific reason: {stderr}"
    );
    assert!(
        !stderr.contains("LOCAL_PORT_CLOSED"),
        "the name is checked before the port, so the port must not be blamed: {stderr}"
    );
}

/// Each rejection reason reaches the user, rather than one code standing in for all of them.
///
/// Written with `--subdomain=<name>` rather than `-s <name>` because of the hyphen case:
/// `-s -myapp` never reaches the validator at all, since clap refuses `-myapp` as an unknown flag
/// first. That is CLI rule 3 doing its job — and it means a leading-hyphen name can only arrive
/// through the `=` form, which is worth knowing before reading it as a gap in the validator.
#[test]
fn the_reason_says_which_rule_was_broken() {
    for (name, reason) in [
        ("ab", "too-short"),
        ("-myapp", "leading-or-trailing-hyphen"),
        ("myapp-", "leading-or-trailing-hyphen"),
        ("ab--cd", "double-hyphen-prefix"),
        ("api", "reserved"),
        ("nport-abc12345", "reserved-prefix"),
    ] {
        let output = nport(&["1", &format!("--subdomain={name}")]);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{name} should have been refused");
        assert!(
            stderr.contains(reason),
            "{name} should have reported {reason}: {stderr}"
        );
        assert!(
            stderr.contains("INVALID_SUBDOMAIN"),
            "{name} should carry the registry code: {stderr}"
        );
    }
}

/// A leading hyphen is refused by clap before the validator sees it, and refused either way.
///
/// Pinned rather than left implicit: the two paths produce different messages for one mistake, and a
/// future change to the flag surface could silently turn the clap refusal into a value that reaches
/// the validator. Both outcomes are acceptable; vanishing is not.
#[test]
fn a_hyphen_led_name_cannot_slip_through_the_flag_parser() {
    let output = nport(&["1", "-s", "-myapp"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unexpected argument") || stderr.contains("INVALID_SUBDOMAIN"),
        "refused by one of the two gates: {stderr}"
    );
}

/// A legal name gets past the check and fails on the *next* gate instead.
///
/// The half that makes the test above mean something: an assertion that a bad name is refused proves
/// nothing if a good one is refused too.
#[test]
fn a_legal_subdomain_gets_as_far_as_the_port_probe() {
    let output = nport(&["1", "-s", "myapp"]);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(!output.status.success(), "port 1 is not listening");
    assert!(
        stderr.contains("LOCAL_PORT_CLOSED"),
        "a valid name should reach the probe: {stderr}"
    );
    assert!(
        !stderr.contains("INVALID_SUBDOMAIN"),
        "`myapp` is a legal name: {stderr}"
    );
}

/// A pasted URL is a claim for the name inside it, not an illegal name.
///
/// This is what the zone-suffix strip is for, and it is the case a user hits by copying their own
/// tunnel's URL back out of the terminal.
#[test]
fn a_pasted_hostname_is_accepted_as_the_name_inside_it() {
    let output = nport(&["1", "-s", "myapp.nport.link"]);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        !stderr.contains("INVALID_SUBDOMAIN"),
        "a pasted hostname normalizes to `myapp`: {stderr}"
    );
    assert!(stderr.contains("LOCAL_PORT_CLOSED"), "{stderr}");
}

/// `--help` still answers before any of this, which is CLI rule 2.
#[test]
fn help_answers_even_with_an_illegal_subdomain() {
    let output = nport(&["--help", "-s", "my_app"]);
    assert!(output.status.success(), "--help must not fail");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Usage"), "help goes to stdout: {stdout}");
}
