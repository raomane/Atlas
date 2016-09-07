/* faceted-datatable-cf
 * datatables, facets, filters controlled by crossfilter
 *
 * Author: Sigfried Gold
 *				 based on faceted-datatable, written by Frank DeFalco and/or Chris Knoll
 *
 * in the old faceted-datatable, filter state was maintained in each facet
 * object in the 'Selected' property.
 *
 * faceted-datatable-cf has some new features that complicate things a little:
 *	- crossfilter is used for filtering records, which is much faster than the old code
 *	- filter state can now be saved to the url (should be optional, but isn't yet)
 *	- filter changes can be broadcast to external listeners
 *	- external filter changes can be caught and reflected here
 *	- facets and columns can now be defined as ohdsi.util.Field objects
 *
 * facet members have to be recalculated when:
 *	- facet selection changes locally
 *	- a filter is set externally (the filter will be reflected in crossfilter,
 *																even though it's not based on a facet)
 *	- the records observable changes (externally)
 *	- facets are initialized
 *	- ?
 */
"use strict";
define(['knockout', 'text!./faceted-datatable-cf.html', 'crossfilter/crossfilter', 'lodash', 'ohdsi.util', 'knockout.dataTables.binding', 'colvis'], 
			 function (ko, view, crossfilter, _, util) {

	var reduceToRecs = [(p, v, nf) => p.concat(v), (p, v, nf) => _.without(p, v), () => []];
	function facetedDatatable(params) {
		window.ko = ko;
		var self = this;

		self.options = params.options; // passed directly to datatable binding
		self.saveState = params.saveStateToUrl;
		self.filterNameSpace = params.filterNameSpace;
		/*
		 * was going to allow shared crossfilter, but not for now
		self.crossfilter = ko.utils.unwrapObservable(params.crossfilter) || 
												crossfilter(self.recs);
		*/

		self.jqEventSpace = params.jqEventSpace || {};

		self.data = ko.observableArray([]);
		self.facets = ko.observableArray([]);

		self.rowCallback = params.rowCallback;
		self.rowClick = params.rowClick || (()=>{});

		// Maybe you want to use facets for filtering, but
		// not the data table?
		self.facetsOnly = params.facetsOnly;

		// Set some defaults for the data table
		self.autoWidth = params.autoWidth || true;
		self.buttons = params.buttons || [
				'colvis','copyHtml5','excelHtml5','csvHtml5','pdfHtml5'
		];
		self.colVis = params.colVis || {
						buttonText: 'Change Columns',
						align: 'right',
						overlayFade: 0,
						showAll: 'Show All Columns',
						restore: 'Reset Columns'
					};
		self.dom = params.dom || 'Blfiprt';
		self.language = params.language || {
						search: 'Filter: '
					};
		self.lengthMenu = params.lengthMenu || [[15, 30, 45, -1], [15, 30, 45,'All']];
		self.order = params.order || [[1,'desc']];
		self.orderClasses = params.orderClasses || false;
		self.ordering = params.ordering || true;

		self.searchFilter = params.searchFilter;

		newRecs(ko.utils.unwrapObservable(params.recs));
		if (ko.isSubscribable(params.recs)) {
			params.recs.subscribe(function(recs) {
				newRecs(recs);
			});
		}

		function newRecs(recs) {
			self.crossfilter = crossfilter(recs);
			processFieldFacetColumnParams();
			self.data(recs);
			columnSetup();
			facetSetup();
		}
		function processFieldFacetColumnParams() {
			// if fields parameter is supplied, columns and facets will be ignored
			if (params.fields) {
				var fields = ko.utils.unwrapObservable(params.fields);
				self.columns = _.filter(fields, d=>d.isColumn);
				self._facets = _.filter(fields, d=>d.isFacet);
				if (ko.isSubscribable(params.fields)) {
					params.fields.subscribe(function(fields) {
						self.columns = _.filter(fields, d=>d.isColumn);
						self._facets = _.filter(fields, d=>d.isFacet);
					});
				}
			} else {
				console.warn(`still supporting old style facet/column config, but 
										  probably best to use ohdsi.util.Field and fields param`);
				if (ko.isObservable(params.columns)) {
					throw new Error("can't deal with observable columns");
				}
				self.columns = params.columns;
				self._facets = ko.utils.unwrapObservable(params.facets);
				if (ko.isSubscribable(params.facets)) {
					params.facets.subscribe(function(facets) {
						newRecs(ko.utils.unwrapObservable(params.recs));
					});
				}
			}
		}
		function columnSetup() {
			sharedSetup(self.columns);
			self.columns.forEach(function(column) {
				column.title = column.title || d3.functor(column.label)();
				column.render = function(data, type, row, meta) {
					// see https://datatables.net/reference/option/columns.render
					if (typeof data !== "undefined")
						return row[data];
					return column.accessor(row);
				};
			})
		}
		function facetSetup() {
			sharedSetup(self._facets);
			self._facets.forEach(function(facet) {
				facet.caption = facet.caption || d3.functor(facet.label)();
				facet.Members = [];
				facet.cfDim = self.crossfilter.dimension(facet.accessor);
				facet.cfDimGroup = facet.cfDim.group();
				facet.cfDimGroupAll = facet.cfDim.groupAll();
				facet.cfDimGroup.reduce(...reduceToRecs);
				facet.cfDimGroupAll.reduce(...reduceToRecs);
			})
			//self.facets(self._facets);
			self._facets.forEach(facet=>{
				updateFilters(facet);
			});
			updateFacets();
		}
		function sharedSetup(fields) {
			fields.forEach(function(field) {
				// need to consistently define what labels and titles and stuff are called and how they're defined
				// but this is ok for now
				if (field instanceof util.Field) {
					field.accessor = field.accessors.value;
				} else {
					field.label = field.label || field.fname;
					field.value = field.value || field.fname;
					field.accessor = field.value;
					if (typeof field.accessor === "string" || isFinite(field.accessor)) {
						field.accessor = d => d[field.value];
					}
					if (typeof field.accessor !== "function") {
						throw new Error("field.value must be function or string or index");
					}
				}
			});
		}

		/*
		 * PUT THIS BACK!
		self.initCompleteCallback = function() {
			var dt=$('#profile-manager-table table').DataTable();
			dt.on('search.dt', function(e, settings) { 
				var s = dt.search();
				if (s.length === 0) {
					self.searchFilter(null);
					return ()=>false;
				}
				self.searchFilter(rec => {
					return _.chain(rec).values().compact().any(val => val.toString().match(new RegExp(s,'i'))).value();
				})
				return true;
			});
		};
		*/

		function filterStateKey() {
			return `filters${self.filterNameSpace ?
								('.' + self.filterNameSpace) :
								''}`;
		}
		function filterName(facetName, memberName) {
			return `${filterStateKey()}.${facetName}.${memberName}`;
		}
		function filterVal(facetName, memberName) {
			return !!util.getState(filterName(facetName, memberName));
		}
		self.toggleFilter = function(data, event) {
			var context = ko.contextFor(event.target);
			var memberName = context.$data.Name;
			var facet = context.$parent;
			var facetName = facet.name;
			var filterOn = !filterVal(facetName, memberName);
			var filterSwitched = filterName(facetName,memberName)
			if (filterOn) {
				util.setState(filterSwitched, true);
			} else {
				util.deleteState(filterSwitched);
			}
			updateFilters(facet);
			$(self.jqEventSpace).trigger('filter', 'internal');
		}
		function updateFilters(facet) {
			var filters = util.getState(filterStateKey());
			if (filters[facet.name]) {
				facet.cfDim.filter(memberName=>filterVal(facet.name, memberName));
			} else {
				facet.cfDim.filter(null);
			}
			updateFacets();
		};
		function updateFacets() {
			self._facets.forEach(facet=>{
				facet.Members = facet.cfDimGroup.all().map(group=>{
					var selected = filterVal(facet.name, group.key);
					return {
						Name: group.key,
						ActiveCount: facet.countFunc ? facet.countFunc(group) : group.value.length,
						Selected: selected,
					};
				});
			});
			self.facets.removeAll()
			self.facets.push(...self._facets);

			var groupAll = self.crossfilter.groupAll();
			groupAll.reduce(...reduceToRecs);
			self.data(groupAll.value());
			//self.data(self.recs());
		}
		$(self.jqEventSpace).on('filter.datatable', function(internal) {
			//throw new Error("check what should happen here");
			if (!internal) {
				updateFacets();
			}
		});
	};

	var component = {
		viewModel: facetedDatatable,
		template: view
	};

	ko.components.register('faceted-datatable-cf', component);
	return component;
});
