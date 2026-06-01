# My Plugin

A FreeSDN plugin built from the official template.

> Replace this README with a description of what your plugin does.

## Develop

```bash
pip install "freesdn-sdk[dev]"
pytest                 # run the tests
freesdn-sdk validate . # check plugin.yaml and structure
freesdn-sdk check .    # static analysis for sandbox violations
```

## Package and install

```bash
freesdn-sdk package .  # builds my-plugin-1.0.0.zip
```

Upload the ZIP in the FreeSDN web UI under Settings - Plugins. Installation is
restricted to `super_admin` users.

## Layout

```
my-plugin/
  plugin.yaml          # manifest: metadata, permissions, settings
  plugin.py            # the plugin class
  tests/test_plugin.py # tests using the SDK mock context
  requirements.txt     # PyPI dependencies (kept in sync with plugin.yaml)
  README.md
```

## Notes

Plugins run in-process with the FreeSDN backend and are not OS-sandboxed. The
SDK gates every call against the permissions declared in `plugin.yaml` and
blocks dangerous imports at load time, but a determined plugin can reach around
that. Only install plugins you trust.

See the [FreeSDN SDK](https://github.com/freesdn/freesdn-sdk) and
[docs.freesdn.org/plugins](https://docs.freesdn.org/plugins/) for the full API
surface, lifecycle hooks, and security model.

## License

MIT.
