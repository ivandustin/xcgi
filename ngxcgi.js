angular
.module('ngXcgi', ['ngResource'])
.config(function($resourceProvider) {
  $resourceProvider.defaults.actions.save = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    transformRequest: function(data) {
      var a = []
      for(var key in data) {
        a.push(key + '=' + encodeURIComponent(data[key]))
      }
      return a.join('&')
    }
  }
  $resourceProvider.defaults.actions.getText = {
    method: 'GET',
    transformResponse: function(data, headersGetter, status) {
        return {text: data}
    }
  }
})
