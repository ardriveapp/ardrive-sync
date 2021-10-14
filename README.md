# ardrive-sync

The ArDrive Sync Command Line App contains basic public and private drive synchronization via a Node.js application. 

It requires you to provide a local Arweave wallet JSON.  It stores this, encrypted, in  local SQLite database that is created in the directory that you run ArDrive-Sync in, called .ardrive-sync.db.  Other file metadata and transaction information is also stored in this database.

To use the ArDrive Sync, install it with your favorite package manager, and run "ardrive-sync".

If you are experiencing permissions issues (Mac OSX), you may also need to place your wallet file in the same directory you are running ardrive-cli

## Developer Setup

Follow these steps to get the developer environment up and running:

### Install Yarn 2

ArDrive Sync uses Yarn 2, so install the latest version with the [yarn installation instructions][yarn-install]. In most cases:

```shell
# Brew:
brew install yarn

# Or with NPM:
npm install -g yarn
```

We also use husky. To enable hooks locally, you will need to run:

```shell
yarn husky install
```

### Installing and Starting ArDrive Sync

Now that everything is set up, to install the package simply run:

```shell
yarn
```

And then start the ArDrive Sync command line app:

```shell
yarn start
```

### Recommended Visual Studio Code extensions

To ensure your environment is compatible, we also recommend the following VSCode extensions:

-   [ES-Lint][eslint-vscode]
-   [Editor-Config][editor-config-vscode]
-   [Prettier][prettier-vscode]
-   [ZipFS][zipfs-vscode]

[yarn-install]: https://yarnpkg.com/getting-started/install
[editor-config-vscode]: https://marketplace.visualstudio.com/items?itemName=EditorConfig.EditorConfig
[prettier-vscode]: https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode
[zipfs-vscode]: https://marketplace.visualstudio.com/items?itemName=arcanis.vscode-zipfs
[eslint-vscode]: https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint
[sqlite-db-webviewer]: https://inloop.github.io/sqlite-viewer/
[sqlite-db-desktopviewer]: https://sqlitebrowser.org/
