{
  description = "Nix packaging for oh-my-codex";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    codex-cli-nix = {
      url = "github:sadjow/codex-cli-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, codex-cli-nix }:
    let
      lib = nixpkgs.lib;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
      pname = packageJson.name;
      version = packageJson.version;
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = lib.genAttrs supportedSystems;
      mkPackages = system:
      let
        pkgs = import nixpkgs { inherit system; };
        inherit (pkgs) stdenv;
        codexPackage = codex-cli-nix.packages.${system}.default;
        nodePlatform =
          if stdenv.hostPlatform.isLinux then "linux"
          else if stdenv.hostPlatform.isDarwin then "darwin"
          else throw "oh-my-codex is only packaged for Linux and Darwin";
        nodeArch =
          if stdenv.hostPlatform.parsed.cpu.name == "x86_64" then "x64"
          else if stdenv.hostPlatform.parsed.cpu.name == "aarch64" then "arm64"
          else throw "Unsupported CPU architecture for oh-my-codex";
        sparkshellPlatformKey = "${nodePlatform}-${nodeArch}";
        exploreBinary = if stdenv.hostPlatform.isWindows then "omx-explore-harness.exe" else "omx-explore-harness";
        sparkshellBinary = if stdenv.hostPlatform.isWindows then "omx-sparkshell.exe" else "omx-sparkshell";
        src = lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            let
              base = builtins.baseNameOf path;
            in
            !builtins.elem base [
              ".codex"
              ".git"
              "dist"
              "node_modules"
              "result"
              "target"
            ];
        };
        exploreHarness = pkgs.rustPlatform.buildRustPackage {
          pname = "omx-explore-harness";
          inherit version src;

          cargoLock.lockFile = ./Cargo.lock;
          cargoBuildFlags = [ "-p" "omx-explore-harness" ];
          doCheck = false;
        };
        sparkshell = pkgs.rustPlatform.buildRustPackage {
          pname = "omx-sparkshell";
          inherit version src;

          cargoLock.lockFile = ./Cargo.lock;
          cargoBuildFlags = [ "-p" "omx-sparkshell" ];
          doCheck = false;
        };
        package = pkgs.buildNpmPackage {
          inherit pname version src;

          npmDepsHash = "sha256-VoifYbL//LTOfCow3/TesUTjE011fSeyakyqHULS4NY=";

          nativeBuildInputs = [
            pkgs.makeWrapper
          ];

          npmBuildScript = "build";

          installPhase = ''
            runHook preInstall

            export HOME="$TMPDIR"
            npm prune --omit=dev --ignore-scripts

            pkgRoot="$out/lib/${pname}"
            mkdir -p "$pkgRoot" "$out/bin" "$pkgRoot/bin/native/${sparkshellPlatformKey}" "$pkgRoot/src"

            cp package.json package-lock.json Cargo.toml Cargo.lock README.md "$pkgRoot/"
            cp -r dist crates prompts skills templates "$pkgRoot/"
            cp -r src/scripts "$pkgRoot/src/"
            cp -r node_modules "$pkgRoot/"

            install -m755 "${exploreHarness}/bin/${exploreBinary}" "$pkgRoot/bin/${exploreBinary}"
            install -m755 "${sparkshell}/bin/${sparkshellBinary}" \
              "$pkgRoot/bin/native/${sparkshellPlatformKey}/${sparkshellBinary}"

            cat > "$pkgRoot/bin/omx-explore-harness.meta.json" <<EOF
            {
              "binaryName": "${exploreBinary}",
              "platform": "${nodePlatform}",
              "arch": "${nodeArch}",
              "strategy": "nix-packaged"
            }
            EOF

            makeWrapper ${pkgs.nodejs}/bin/node "$out/bin/omx" \
              --prefix PATH : ${lib.escapeShellArg (lib.makeBinPath [ pkgs.nodejs codexPackage ])} \
              --add-flags "$pkgRoot/dist/cli/omx.js"

            runHook postInstall
          '';

          meta = with lib; {
            description = packageJson.description;
            homepage = packageJson.homepage;
            license = licenses.mit;
            mainProgram = "omx";
            platforms = platforms.linux ++ platforms.darwin;
          };
        };
      in
      {
        inherit package;
      };
    in
    {
      packages = forAllSystems (system:
        let
          built = mkPackages system;
        in
        {
          default = built.package;
          omx = built.package;
          oh-my-codex = built.package;
        });

      apps = forAllSystems (system:
        let
          package = self.packages.${system}.default;
        in
        {
          default = {
            type = "app";
            program = "${package}/bin/omx";
          };
          omx = {
            type = "app";
            program = "${package}/bin/omx";
          };
        });
    };
}
