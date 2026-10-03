PYTHON ?= python3

.PHONY: all prepare build package verify test gui-smoke run

all:
	$(PYTHON) scripts/build.py all

prepare:
	$(PYTHON) scripts/build.py prepare

build: prepare
	$(PYTHON) scripts/build.py build

package: build
	$(PYTHON) scripts/build.py package

verify:
	$(PYTHON) scripts/build.py verify

test:
	$(PYTHON) -m unittest discover -s tests -v
	node --test tests/*.test.mjs

gui-smoke:
	xvfb-run -a node scripts/gui-smoke.mjs

run:
	$(PYTHON) scripts/build.py launch
