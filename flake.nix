{
  description = "Public chat rooms (Vue 3 + Socket.IO): development shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in {
      # nix develop  ->  npm install && npm run dev-server   (and npm run dev in a second terminal)
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [ nodejs_22 docker-compose ];
      };
    };
}
