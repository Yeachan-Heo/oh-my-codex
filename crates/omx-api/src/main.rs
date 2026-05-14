fn main() {
    if let Err(error) = omx_api::run_cli(
        std::env::args().skip(1),
        std::io::stdout(),
        std::io::stderr(),
    ) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
