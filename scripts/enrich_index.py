#!/usr/bin/env python3
"""Add browse/sort fields to docs/data/index.json: continent, run count; drop fields the UI doesn't use.

Run after build_data.py.
"""
import json, os

DATA = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data')
CONT = {}
for c, codes in {
    'Europe': 'AD AL AT BA BE BG BY CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK',
    'Asia': 'AM AZ CN GE IL IN IR JP KG KP KR KZ LB MN PK TJ TR TW UZ AF IQ SY',
    'North America': 'CA US MX GL',
    'South America': 'AR BR CL BO PE',
    'Oceania': 'AU NZ',
    'Africa': 'LS MA ZA DZ',
}.items():
    for k in codes.split():
        CONT[k] = c

index = json.load(open(os.path.join(DATA, 'index.json')))
for e in index:
    d = json.load(open(os.path.join(DATA, 'resorts', e['id'] + '.json')))
    e['nRuns'] = len(d['runs'])
    e['cont'] = CONT.get(e['country'], 'Other')
    e['vert'] = round(e['top'] - e['base']) if e.get('top') is not None and e.get('base') is not None else None
    for k in ('osm', 'diffKm', 'website', 'center'):
        e.pop(k, None)
    if e.get('fullName') == e['name']:
        e.pop('fullName')
    e['top'] = round(e['top']) if e.get('top') is not None else None
    e['base'] = round(e['base']) if e.get('base') is not None else None
json.dump(index, open(os.path.join(DATA, 'index.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(index), 'entries;', os.path.getsize(os.path.join(DATA, 'index.json')) // 1024, 'KB')
